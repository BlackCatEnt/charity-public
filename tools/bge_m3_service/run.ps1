$env:PYTHONUTF8=1
$env:BGE_ONNX_PATH = 'A:\models\bge-m3\bge-m3.onnx'
$env:BGE_TOKENIZER_JSON = 'A:\models\bge-m3\tokenizer.json'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
# venv
if (-not (Test-Path .venv)) { py -3 -m venv .venv }
. .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install fastapi uvicorn onnxruntime-directml tokenizers
# run service on 127.0.0.1:8009
uvicorn service:app --host 127.0.0.1 --port 8009 --workers 1
