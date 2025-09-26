import io, os, tempfile
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

app = FastAPI()
#model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
model = WhisperModel("base", device="cpu", compute_type="int8")

@app.get("/health")
def health():
    return {"ok": True}

def transcribe_path(path: str):
    segments, info = model.transcribe(path, beam_size=1, vad_filter=True)
    text = "".join([s.text for s in segments]).strip()
    return {"text": text, "lang": info.language, "duration": info.duration}

@app.post("/transcribe")
async def transcribe(request: Request, file: UploadFile | None = File(default=None)):
    # 1) If multipart upload (file=) was used
    if file is not None:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        try:
            return JSONResponse(transcribe_path(tmp_path))
        finally:
            try: os.remove(tmp_path)
            except: pass

    # 2) Raw bytes (application/octet-stream or audio/wav)
    body = await request.body()
    if not body or len(body) < 128:   # tiny/empty — likely still being written
        return JSONResponse({"error": "empty_or_too_small"}, status_code=400)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
        tmp.write(body)
        tmp_path = tmp.name
    try:
        return JSONResponse(transcribe_path(tmp_path))
    finally:
        try: os.remove(tmp_path)
        except: pass
