# A:\Charity\relics\vad_streamer\vad_streamer.py  (clean callback version)
import argparse, sys, wave, io, json, queue
import numpy as np
import sounddevice as sd
import webrtcvad
import requests

def wav_bytes_from_int16(mono_int16: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(mono_int16.tobytes())
    return buf.getvalue()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', default='CABLE Output (VB-Audio Virtual Cable)')
    ap.add_argument('--sr', type=int, default=16000)
    ap.add_argument('--frame_ms', type=int, default=20)        # 10/20/30
    ap.add_argument('--vad', type=int, default=2)              # 0-3
    ap.add_argument('--start_ms', type=int, default=300)       # voiced to start
    ap.add_argument('--end_ms', type=int, default=600)         # silence to end
    ap.add_argument('--max_ms', type=int, default=15000)       # cap
    ap.add_argument('--asr', default='http://127.0.0.1:8123/transcribe')
    ap.add_argument('--hall', default='http://127.0.0.1:8130/asr')
    ap.add_argument('--speaker', default='Bagotrix')
    ap.add_argument('--game', default='Unknown')
    ap.add_argument('--scene', default='Unknown')
    ap.add_argument('--origin', default='mic')
    args = ap.parse_args()

    # device
    devs = sd.query_devices()
    idx = None
    for i,d in enumerate(devs):
        if d.get('name','') == args.input and d.get('max_input_channels',0)>0:
            idx = i; break
    if idx is None:
        print(f'[vad] ERROR device not found: {args.input}')
        for d in devs:
            if d.get('max_input_channels',0)>0: print('  -', d['name'])
        sys.exit(2)

    # VAD params
    vad = webrtcvad.Vad(args.vad)
    spf = int(args.sr * (args.frame_ms/1000.0))   # samples per frame
    voiced_need = args.start_ms // args.frame_ms
    silence_need = args.end_ms // args.frame_ms
    max_frames = args.max_ms // args.frame_ms

    qin: "queue.Queue[bytes]" = queue.Queue()
    collecting = False
    voiced_run = 0
    silence_run = 0
    frames_in_utter = 0
    chunk = bytearray()

    def cb(indata, frames, timeinfo, status):
        if status:
            print('[vad] stream status:', status, flush=True)
        qin.put(bytes(indata))

    with sd.RawInputStream(device=idx, channels=1, samplerate=args.sr,
                           dtype='int16', blocksize=spf, callback=cb):
        print(f'[vad] listening on "{args.input}" at {args.sr}Hz, {args.frame_ms}ms frames, VAD={args.vad}')
        while True:
            b = qin.get()  # one frame of bytes (len == spf*2)
            is_voiced = vad.is_speech(b, args.sr)
            if is_voiced:
                voiced_run += 1
                silence_run = 0
            else:
                silence_run += 1

            if not collecting and voiced_run >= voiced_need:
                collecting = True
                chunk = bytearray()
                frames_in_utter = 0
                # keep the current frame (start of speech)
                chunk.extend(b)

            if collecting:
                # accumulate
                if frames_in_utter == 0 and not is_voiced:
                    # in case start coincided with silence decision, still add
                    pass
                if frames_in_utter > 0:
                    chunk.extend(b)
                frames_in_utter += 1

                # stop conditions
                should_end = (silence_run >= silence_need) or (frames_in_utter >= max_frames)
                if should_end:
                    # flush
                    arr = np.frombuffer(chunk, dtype=np.int16)
                    wav_bytes = wav_bytes_from_int16(arr, args.sr)
                    # reset state
                    collecting = False
                    voiced_run = 0
                    silence_run = 0
                    frames_in_utter = 0
                    # post to ASR
                    arr = np.frombuffer(chunk, dtype=np.int16)
                    if arr.size < int(args.sr * 0.2):   # < ~200ms of audio? skip
                        collecting = False; voiced_run = silence_run = frames_in_utter = 0
                        return
                    wav_bytes = wav_bytes_from_int16(arr, args.sr)

                    try:
                        r = requests.post(args.asr, files={'file': ('chunk.wav', wav_bytes, 'audio/wav')}, timeout=30)
                        if r.status_code != 200:
                            print('[vad] ASR non-200:', r.status_code, r.text); continue
                        js = r.json()
                        text = (js.get('text') or '').strip()
                        lang = js.get('lang') or 'en'
                        dur  = js.get('duration')
                        print(f'[vad] ASR: "{text}" (lang={lang}, dur={dur})')
                        if text:
                            payload = {
                                'text': text, 'lang': lang,
                                'tags': {
                                    'speaker': args.speaker,
                                    'game': args.game,
                                    'scene': args.scene,
                                    'origin': args.origin
                                }
                            }
                            r2 = requests.post(args.hall, json=payload, timeout=10)
                            if r2.status_code != 200:
                                print('[vad] Hall non-200:', r2.status_code, r2.text)
                            else:
                                print('[vad] Hall ok')
                    except Exception as e:
                        print('[vad] POST failed:', e)

            # decay voiced streak if not voiced
            if not is_voiced and not collecting and voiced_run > 0:
                voiced_run = max(0, voiced_run - 1)

if __name__ == '__main__':
    main()
