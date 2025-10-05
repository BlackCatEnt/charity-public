# A:\Charity\tools\bge_m3_service\service.py
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List
import numpy as np
import onnxruntime as ort
import warnings
warnings.filterwarnings("ignore", message="Unsupported Windows version")
from tokenizers import Tokenizer

# --- config: set your paths ---
ONNX_PATH = r"A:\models\bge-m3\bge-m3.onnx"
TOKENIZER_JSON = r"A:\models\bge-m3\tokenizer.json"
MAX_LEN = 512          # match your config
EMBED_DIMS = 1024      # bge-m3 base

# --- providers: DirectML first, CPU fallback ---
providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
sess = ort.InferenceSession(ONNX_PATH, providers=providers)

tok = Tokenizer.from_file(TOKENIZER_JSON)

app = FastAPI()

class EmbedReq(BaseModel):
    texts: List[str]

def _prep(text: str):
    enc = tok.encode(text or "")
    ids = enc.ids[:MAX_LEN]
    mask = [1]*len(ids)
    # pad
    if len(ids) < MAX_LEN:
        pad = MAX_LEN - len(ids)
        ids = ids + [0]*pad
        mask = mask + [0]*pad
    return np.array([ids], dtype=np.int64), np.array([mask], dtype=np.int64)

def _embed_one(text: str):
    input_ids, attention_mask = _prep(text)
    # common output names: 'last_hidden_state'/'token_embeddings', then mean-pool
    outs = sess.run(None, {"input_ids": input_ids, "attention_mask": attention_mask})
    X = outs[0]  # (1, seq, hidden) or (1, hidden)
    if X.ndim == 3:
        # mean pooling with mask
        mask = attention_mask.astype(np.float32)
        mask = mask[..., None]  # (1, seq, 1)
        summed = (X * mask).sum(axis=1)
        denom = np.clip(mask.sum(axis=1), 1e-6, None)
        vec = summed / denom
    else:
        vec = X  # already pooled (1, hidden)
    v = vec[0].astype(np.float32)
    # L2 normalize
    n = np.linalg.norm(v) or 1.0
    return (v / n).tolist()

@app.get("/health")
def health():
    return {"ok": True, "providers": sess.get_providers()}

@app.post("/embed")
def embed(req: EmbedReq):
    out = [_embed_one(t) for t in req.texts]
    return {"embeddings": out, "dims": EMBED_DIMS}
