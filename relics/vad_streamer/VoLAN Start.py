python A:\Charity\adapters\asr.service\vad_streamer.py ^
  --device "RODECaster Pro II Main Stereo" ^
  --rate 16000 --channels 1 ^
  --min-voice 240ms --min-silence 650ms --max-utterance 20s ^
  --asr  http://192.168.0.49:8123/transcribe ^
  --hall http://192.168.0.49:8130/asr ^
  --tag origin=mic --tag game="%CURRENT_GAME%" --tag scene="%CURRENT_SCENE%" --tag speaker=Bagotrix
