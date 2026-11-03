#!/usr/bin/env python3
"""Real Pi + PulseAudio/PipeWire + hosted API smoke. Makes paid/quota-consuming STT calls."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import re
import struct
import subprocess
import tempfile
import termios
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--provider', choices=['groq', 'deepgram', 'both'], default='deepgram')
parser.add_argument('--audio', type=Path, help='Public speech fixture; defaults to Whisper JFK test audio')
args = parser.parse_args()
for executable in ['pi', 'ffmpeg', 'pactl', 'paplay']:
    if not shutil.which(executable):
        raise SystemExit(f'Missing prerequisite: {executable}')
repo = Path(__file__).resolve().parent.parent
config_file = Path(os.environ.get('PI_VOICE_CONFIG', Path.home()/'.config/pi-voice/config.json')).expanduser()
base = json.loads(config_file.read_text())
providers = ['groq', 'deepgram'] if args.provider == 'both' else [args.provider]

with tempfile.TemporaryDirectory(prefix='pi-voice-live-') as temporary:
    root = Path(temporary)
    reference = args.audio
    if reference is None:
        reference = root/'jfk.flac'
        urllib.request.urlretrieve('https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac', reference)
    fixture = root/'phrases.wav'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(reference),
                    '-filter_complex', '[0:a]asplit=2[a][b];[a]atrim=0:3.5,asetpts=PTS-STARTPTS[a1];[b]atrim=4:9,asetpts=PTS-STARTPTS[b1];anullsrc=r=16000:cl=mono,atrim=0:1[s];[a1][s][b1]concat=n=3:v=0:a=1[out]',
                    '-map', '[out]', '-ar', '16000', '-ac', '1', str(fixture)], check=True)
    sink = f'pi_voice_smoke_{os.getpid()}'
    module = subprocess.check_output(['pactl', 'load-module', 'module-null-sink', f'sink_name={sink}', 'channels=1', 'rate=16000'], text=True).strip()
    try:
        for provider in providers:
            snapshot_file = root/'snapshot.json'
            snapshot_file.unlink(missing_ok=True)
            config = {**base, 'provider': provider, 'capture': {'ffmpegPath': 'ffmpeg', 'device': sink+'.monitor'}}
            local_config = root/'config.json'
            local_config.write_text(json.dumps(config))
            probe = root/'probe.ts'
            probe.write_text('''import {writeFileSync} from "node:fs";
import {isKittyProtocolActive} from "@earendil-works/pi-tui";
export default function probe(pi) {
  let timer; let unsubscribe; let status="unknown"; let packets=0;
  const wire={connections:0,opens:0,audioBytes:0,interims:0,finals:[],lastText:"",lastFinal:true,firstInterimBytes:null,closeStream:0,closed:0,http:0};
  const NativeSocket=globalThis.WebSocket;
  globalThis.WebSocket=class extends NativeSocket {
    constructor(url,protocols){
      super(url,protocols);
      this.observed=new URL(url).hostname==="api.deepgram.com";
      if(!this.observed)return;
      wire.connections++;
      this.addEventListener("open",()=>wire.opens++);
      this.addEventListener("close",event=>{wire.closed=event.code;});
      this.addEventListener("message",event=>{
        try{
          const data=JSON.parse(event.data);
          if(data.type!=="Results")return;
          const text=data.channel.alternatives[0].transcript;
          wire.lastText=text; wire.lastFinal=data.is_final;
          if(data.is_final){if(text.trim())wire.finals.push(text);}
          else if(text.trim()){wire.interims++;wire.firstInterimBytes??=wire.audioBytes;}
        }catch{}
      });
    }
    send(data){
      if(this.observed){
        if(typeof data==="string"){try{if(JSON.parse(data).type==="CloseStream")wire.closeStream++;}catch{}}
        else wire.audioBytes+=data.byteLength||data.size||0;
      }
      return super.send(data);
    }
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=new URL(typeof input==="string"?input:input.url||String(input));
    if(url.hostname==="api.deepgram.com"&&url.pathname==="/v1/listen")wire.http++;
    return originalFetch(input,init);
  };
  pi.on("session_start", (_event,ctx)=>{
    timer=setInterval(()=>{
    const factory=ctx.ui.getEditorComponent();
    if (!factory) return;
    clearInterval(timer);
    const originalStatus=ctx.ui.setStatus.bind(ctx.ui);
    ctx.ui.setStatus=(key,value)=>{if(key==="pi-voice")status=value||"";originalStatus(key,value);};
    unsubscribe=ctx.ui.onTerminalInput(data=>{
      if ((/^ +$/.test(data)||data.startsWith("\\x1b[32")) && ++packets===65) {
        const deadline=performance.now()+350; while(performance.now()<deadline) {}
      }
    });
    ctx.ui.setEditorComponent((...parameters)=>{
      const editor=factory(...parameters);
      timer=setInterval(()=>{try{writeFileSync(process.env.PI_VOICE_SMOKE_SNAPSHOT,JSON.stringify({text:editor.getText(),cursor:editor.getCursor(),status,kitty:isKittyProtocolActive(),wire}));}catch{}},25);
      return editor;
    });
    },25);
  });
  pi.on("session_shutdown",()=>{clearInterval(timer);unsubscribe?.();globalThis.WebSocket=NativeSocket;globalThis.fetch=originalFetch;});
}
''')
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 150, 0, 0))
            env = {**os.environ, 'TERM': 'xterm-256color', 'PI_VOICE_CONFIG': str(local_config), 'PI_VOICE_SMOKE_SNAPSHOT': str(snapshot_file)}
            process = subprocess.Popen(['pi', '--no-session', '-e', str(probe)], stdin=slave, stdout=slave, stderr=slave, cwd=repo, env=env, start_new_session=True)
            os.close(slave)
            terminal = bytearray()
            negotiated = False
            captured = []
            playing = None
            try:
                def send(data):
                    os.write(master, data)

                def snapshot():
                    try:
                        value=json.loads(snapshot_file.read_text())
                        captured.append(value)
                        return value
                    except (FileNotFoundError,json.JSONDecodeError):
                        return None

                def pump(seconds):
                    global negotiated
                    end=time.monotonic()+seconds
                    while time.monotonic()<end:
                        ready,_,_=select.select([master],[],[],min(.02,max(0,end-time.monotonic())))
                        if ready:
                            data=os.read(master,65536)
                            if not data: raise RuntimeError('Pi exited before smoke completed')
                            terminal.extend(data)
                            if not negotiated and b'\x1b[?u' in terminal:
                                # Deliberately negotiate disambiguation WITHOUT repeat/release labels.
                                send(b'\x1b[?1u\x1b[?1;2c'); negotiated=True

                def until(predicate, timeout=20):
                    deadline=time.monotonic()+timeout
                    while time.monotonic()<deadline:
                        pump(.05)
                        value=snapshot()
                        if value is not None and predicate(value): return value
                    raise AssertionError(f'{provider}: condition not reached; last snapshot={snapshot()}')

                until(lambda value:'hold Space' in value['status'])
                send(b'normal'); pump(.05); send(b' '); pump(.05); send(b'typing')
                until(lambda value:value['text']=='normal typing')
                send(b'\x03'); until(lambda value:value['text']=='')
                seed='prefix SUFFIX'
                send(seed.encode()); until(lambda value:value['text']==seed)
                for _ in range(6): send(b'\x1b[D'); pump(.03)
                anchor=until(lambda value:value['cursor']['col']==7)
                # One physical down, OS delay, then repeated press packets. No key-up event.
                send(b'\x1b[32u' if provider=='deepgram' else b' '); pump(.5)
                tick=0
                def hold_for(seconds):
                    global tick
                    deadline=time.monotonic()+seconds
                    while time.monotonic()<deadline:
                        if provider=='groq': send(b' '*(1+tick%3))
                        else: send(b'\x1b[32u')
                        tick+=1
                        pump(.035)
                        snapshot()

                hold_for(1.2)
                recording=snapshot()
                assert recording['status'].startswith('recording'), recording
                assert recording['text']==seed and recording['cursor']==anchor['cursor'], recording
                baseline=len(captured)
                hold_for(1)
                for value in captured[baseline:]:
                    assert value['text']==seed and value['cursor']==anchor['cursor'], ('Space moved cursor during silence',value)
                print(f'{provider}: PASS — OS-style repeat cadence, batched/unlabelled Space, cursor stationary during silence', flush=True)
                audio_start_bytes=snapshot()['wire']['audioBytes']
                saw_interim=False
                playing=subprocess.Popen(['paplay','--device='+sink,str(fixture)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                changes=[]
                last=recording
                deadline=time.monotonic()+35
                while time.monotonic()<deadline:
                    hold_for(.1)
                    value=snapshot()
                    assert value['status'].startswith('recording'), ('Hold stopped while Space was still down',value)
                    if value['text']!=last['text']:
                        assert value['text'].endswith(' SUFFIX'), value
                        if provider=='groq':
                            assert value['text'].startswith(last['text'][:-7]), ('Earlier transcript was overwritten',value)
                        else:
                            assert value['text'].startswith('prefix '), value
                        assert any(c.isalpha() for c in value['text'][7:-7]), ('Literal spaces reached editor',value)
                        changes.append(value)
                        kind='interim' if provider=='deepgram' and not value['wire']['lastFinal'] else 'final'
                        print(f'{provider}: {kind} while held at column {value["cursor"]["col"]}: {value["text"]!r}', flush=True)
                    elif value['cursor']!=last['cursor']:
                        raise AssertionError(('Cursor advanced without new transcript',last,value))
                    last=value
                    if provider=='deepgram' and not value['wire']['lastFinal'] and value['wire']['lastText'].strip():
                        expected=' '.join((' '.join(value['wire']['finals'])+' '+value['wire']['lastText']).split())
                        saw_interim|=value['text'][7:-7].strip()==expected
                    if provider=='groq' and len(changes)>=2: break
                    if provider=='deepgram' and len(value['wire']['finals'])>=2 and saw_interim: break
                assert len(changes)>=2, ('Expected incremental transcripts before key release',snapshot())
                if provider=='deepgram':
                    wire=snapshot()['wire']
                    assert saw_interim and wire['interims']>0, ('No actual server interim rendered',snapshot())
                    assert wire['firstInterimBytes']-audio_start_bytes<3.5*32000, ('Interim did not arrive until the first pause',wire)
                # Stopping repeats is the only release signal: finalization must still work.
                finalized=until(lambda value:value['status'].startswith('voice '),40)
                if provider=='deepgram':
                    wire=finalized['wire']
                    assert wire['connections']==1 and wire['opens']==1 and wire['audioBytes']>0, wire
                    assert wire['http']==0 and wire['closeStream']==1 and wire['closed']==1000, wire
                    expected=' '.join(' '.join(wire['finals']).split())
                    assert finalized['text'][7:-7].strip()==expected, ('Final duplicated or lost an interim',finalized)
                    print('deepgram: PASS — continuous raw-PCM WebSocket, server interims before pause, zero HTTP uploads, clean finalization',flush=True)
                assert b'prefix' in terminal, 'No rendered terminal surface observed'
                send(b'\x03'); until(lambda value:value['text']=='')
                send(b'keep'); pump(.05)
                send(b' '); pump(.5); hold_for(.8)
                assert snapshot()['status'].startswith('recording')
                if provider=='deepgram':
                    before_interims=snapshot()['wire']['interims']
                    playing=subprocess.Popen(['paplay','--device='+sink,str(fixture)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    deadline=time.monotonic()+10
                    while time.monotonic()<deadline:
                        hold_for(.1)
                        live=snapshot()
                        if live['wire']['interims']>before_interims and not live['wire']['lastFinal'] and live['text']!='keep':
                            break
                    else:
                        raise AssertionError('No live provisional text available to cancel')
                    if playing.poll() is None:
                        playing.terminate(); playing.wait(timeout=5)
                send(b'\x1b'); pump(1)
                assert snapshot()['text']=='keep', snapshot()
                assert snapshot()['status'].startswith('voice '), snapshot()
                if provider=='deepgram':
                    print('deepgram: PASS — Escape removes the actual server interim and blocks late text',flush=True)
                send(b'\x1b[32;1u'); pump(.5); hold_for(.8)
                assert snapshot()['status'].startswith('recording'), snapshot()
                send(b'\x1b[32;1:3u')
                until(lambda value:value['status'].startswith('voice '),10)
                assert snapshot()['text']=='keep', snapshot()
                send(b'\x03'); until(lambda value:value['text']=='')
                send(b'\x1b[200~pasted   spaces\x1b[201~')
                until(lambda value:value['text']=='pasted   spaces')
                assert snapshot()['status'].startswith('voice '), snapshot()
                print(f'{provider}: PASS — incremental real API text, release-gap finalization, Escape, suffix preservation, stalled event loop', flush=True)
            except Exception:
                rendered=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', terminal.decode(errors='replace'))
                print('Pi terminal diagnostic:', list(dict.fromkeys(re.findall(r'.{0,80}(?:Error|error|failed|voice).{0,300}', rendered)))[:16], flush=True)
                raise
            finally:
                if playing is not None and playing.poll() is None:
                    playing.terminate(); playing.wait(timeout=5)
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
                os.close(master)
    finally:
        subprocess.run(['pactl','unload-module',module],check=True)
