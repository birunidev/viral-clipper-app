FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-devel
WORKDIR /workspace
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt
COPY . .
# datasets expected at /workspace/datasets (mount) or copied
CMD ["python", "scripts/train.py", "--config", "configs/lora_qwen3_4b.yaml"]
