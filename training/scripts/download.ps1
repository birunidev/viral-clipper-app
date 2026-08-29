# PowerShell download helper — uses host HF cache on D:
# Usage in PowerShell:
#   .\training\scripts\download.ps1
#   .\training\scripts\download.ps1 -Model Qwen/Qwen3-4B

param([string]$Model="Qwen/Qwen3-4B")
$env:HF_HOME="D:/projects/projects/products/clipzard/.hf-cache"
$env:HUGGINGFACE_HUB_CACHE="D:/projects/projects/products/clipzard/.hf-cache"
$env:HF_XET_HIGH_PERFORMANCE="1"
# HF_TOKEN already in training/.env, will be read by python script
python training/scripts/download_model.py --model $Model --cache $env:HF_HOME
