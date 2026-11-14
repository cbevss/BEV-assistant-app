"""Generates train_hey_bev.ipynb. Edit this file, then run:

    python training/build_notebook.py

Kept as a script so the notebook's shell steps, helper scripts and pins live
in one reviewable place (and can be smoke-tested outside Colab).
"""

import json
from pathlib import Path

HERE = Path(__file__).parent

# Exact versions this was tested with (Python 3.12, Nov 2026).
OPENWAKEWORD_COMMIT = "368c03716d1e92591906a84949bc477f3a834455"
PIPER_SAMPLE_GENERATOR_TAG = "v2.0.0"  # openWakeWord imports generate_samples from v2's layout
TORCH = "torch==2.4.1 torchaudio==2.4.1"

REQUIREMENTS = """\
numpy==1.26.4
scipy==1.13.1
piper-phonemize-cross==1.2.1
webrtcvad-wheels==2.0.14
mutagen==1.47.0
torchinfo==1.8.0
torchmetrics==1.2.0
speechbrain==0.5.16
audiomentations==0.33.0
torch-audiomentations==0.11.0
acoustics==0.2.6
pronouncing==0.2.0
pyyaml
onnx==1.16.2
onnxruntime==1.20.1
onnxscript
tqdm
requests
datasets==2.21.0
huggingface-hub==0.24.7
librosa==0.10.2.post1
soundfile
pyarrow==17.0.0
setuptools<81
"""

DOWNLOAD_DATA = r'''"""Downloads the training data openWakeWord needs. Safe to re-run: finished
parts are skipped. Everything goes under /content/data."""
import os
import sys
import tarfile
from pathlib import Path

import datasets
import numpy as np
import scipy.io.wavfile
from huggingface_hub import hf_hub_download
from tqdm import tqdm

ROOT = Path("/content/data")
ROOT.mkdir(exist_ok=True)


def save16k(path, array):
    array = np.asarray(array, dtype=np.float32)
    if array.ndim > 1:  # reverb and mixing code expects mono
        array = array.mean(axis=0)
    scipy.io.wavfile.write(path, 16000, (np.clip(array, -1, 1) * 32767).astype(np.int16))


def done(path, minimum=1):
    return path.exists() and len(os.listdir(path)) >= minimum


# 1. Room impulse responses (makes the synthetic voices sound like real rooms). Required.
rirs = ROOT / "mit_rirs"
if not done(rirs, 200):
    rirs.mkdir(exist_ok=True)
    ds = datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True)
    ds = ds.cast_column("audio", datasets.Audio(sampling_rate=16000))
    for row in tqdm(ds, desc="Room impulse responses"):
        save16k(rirs / row["audio"]["path"].split("/")[-1], row["audio"]["array"])
print("Room impulse responses:", len(os.listdir(rirs)))

# 2. Background noise and music to mix under the voices. At least one source must work.
background_dirs = []

audioset = ROOT / "audioset_16k"
try:
    if not done(audioset, 100):
        audioset.mkdir(exist_ok=True)
        tar_path = hf_hub_download("agkphysics/AudioSet", "data/bal_train09.tar", repo_type="dataset", local_dir=ROOT / "audioset_raw")
        with tarfile.open(tar_path) as t:
            t.extractall(ROOT / "audioset_raw")
        flacs = [str(p) for p in (ROOT / "audioset_raw").glob("**/*.flac")]
        ds = datasets.Dataset.from_dict({"audio": flacs}).cast_column("audio", datasets.Audio(sampling_rate=16000))
        for row in tqdm(ds, desc="AudioSet"):
            save16k(audioset / Path(row["audio"]["path"]).with_suffix(".wav").name, row["audio"]["array"])
    background_dirs.append(str(audioset))
except Exception as e:
    print("AudioSet download failed, continuing without it:", e)

fma = ROOT / "fma"
try:
    if not done(fma, 100):
        fma.mkdir(exist_ok=True)
        ds = datasets.load_dataset("rudraml/fma", name="small", split="train", streaming=True, trust_remote_code=True)
        ds = iter(ds.cast_column("audio", datasets.Audio(sampling_rate=16000)))
        for _ in tqdm(range(120), desc="Free Music Archive (1 hour)"):  # 120 x 30 s clips
            row = next(ds)
            save16k(fma / Path(row["audio"]["path"]).with_suffix(".wav").name, row["audio"]["array"])
    background_dirs.append(str(fma))
except Exception as e:
    print("FMA download failed, continuing without it:", e)

if not background_dirs:
    sys.exit("No background audio could be downloaded. Check the errors above, then re-run this cell.")
(ROOT / "background_dirs.txt").write_text("\n".join(background_dirs))
print("Background audio:", background_dirs)

# 3. Pre-computed features: ~2,000 hours of ordinary audio that must NOT trigger
#    the wake word, plus ~11 hours used to measure false triggers. Required.
for name in ["openwakeword_features_ACAV100M_2000_hrs_16bit.npy", "validation_set_features.npy"]:
    if not (ROOT / name).exists():
        print(f"Downloading {name} (large, a few minutes)…")
        hf_hub_download("davidscripka/openwakeword_features", name, repo_type="dataset", local_dir=ROOT)
    print(name, f"{(ROOT / name).stat().st_size / 1e9:.1f} GB")

print("\nAll training data ready.")
'''

CHECK_MODEL = r'''"""Scores the trained model on the held-out clips from step 1: "hey BEV" clips
should score high, the sound-alike phrases low."""
import json
import sys
from pathlib import Path

import numpy as np
from openwakeword.model import Model

cfg = json.load(open(sys.argv[1]))
model_path = Path(cfg["output_dir"]) / f"{cfg['model_name']}.onnx"
clips = Path(cfg["output_dir"]) / cfg["model_name"]
model = Model(wakeword_models=[str(model_path)], inference_framework="onnx")


def max_scores(folder, limit=300):
    files = sorted(folder.glob("*.wav"))[:limit]
    out = []
    for f in files:
        model.reset()
        preds = model.predict_clip(str(f))
        out.append(max(float(list(p.values())[0]) for p in preds))
    return np.array(out)


pos = max_scores(clips / "positive_test")
neg = max_scores(clips / "negative_test")
print(f"Model: {model_path} ({model_path.stat().st_size // 1024} KB)\n")
print("Trigger point   'hey BEV' caught   sound-alikes triggered")
for t in (0.3, 0.5, 0.7):
    print(f"   {t:.1f}            {np.mean(pos >= t):6.1%}            {np.mean(neg >= t):6.1%}")
print("\nBEV's sensitivity slider at 50% uses a trigger point of 0.5.")
if np.mean(pos >= 0.5) < 0.6:
    print("Fewer than 60% caught at 0.5: consider re-running with more STEPS or N_SAMPLES.")
'''


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text, title=None):
    meta = {"cellView": "form"} if title else {}
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": meta,
        "outputs": [],
        "source": text.strip("\n").splitlines(keepends=True),
    }


cells = [
    md(
        """
# Train BEV's on-device wake word ("hey BEV")

This notebook trains a small **openWakeWord** model that lets BEV hear "hey BEV" entirely on your PC: no account, no key, nothing uploaded.

**How to run it**
1. **Runtime → Change runtime type → T4 GPU** (free), then Save.
2. **Runtime → Run all.** It takes roughly an hour. Keep this tab open.
3. At the end your browser downloads **`hey_bev.onnx`**.
4. In BEV: **Voice & Audio → Wake word → Engine: On-device → Load model**, pick the file, then use **Test** to try it and tune **Wake-word sensitivity**.

It works by generating thousands of synthetic voices saying "hey BEV" (and sound-alikes such as "hey Ben" that must *not* trigger), mixing them with room echo and background noise, and training a small detector on top of openWakeWord's speech features.

*Credit: [openWakeWord](https://github.com/dscripka/openWakeWord) by David Scripka (Apache-2.0) and [piper-sample-generator](https://github.com/rhasspy/piper-sample-generator). The official training notebook no longer installs on current Colab; this one pins working versions.*
"""
    ),
    code(
        """
#@title 1. Settings (the defaults are fine) { display-mode: "form" }
WAKE_PHRASE = "hey bev"  #@param {type:"string"}
#@markdown More samples and steps → a better model, but a longer run.
N_SAMPLES = 8000  #@param {type:"integer"}
N_SAMPLES_VAL = 1500  #@param {type:"integer"}
STEPS = 30000  #@param {type:"integer"}
#@markdown Phrases that sound close and must NOT wake BEV (comma separated):
SOUND_ALIKES = "hey ben, hey beth, hey bed, hey kev, hey dev, hey deb, hey babe, hey bear, heavy, hey there"  #@param {type:"string"}

MODEL_NAME = WAKE_PHRASE.strip().lower().replace(" ", "_")
print("Will train:", repr(WAKE_PHRASE), "→", MODEL_NAME + ".onnx")
""",
        title=True,
    ),
    code(
        """
#@title 2. Check for a GPU { display-mode: "form" }
import subprocess
try:
    gpu = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True).stdout.strip()
except FileNotFoundError:  # no GPU runtime: the tool isn't even installed
    gpu = ""
if gpu:
    print("GPU:", gpu)
else:
    print("⚠ No GPU. It will still work but be several times slower. "
          "Runtime → Change runtime type → T4 GPU, then Runtime → Run all.")
""",
        title=True,
    ),
    code(
        f"""
%%bash
# 3. Install (about 3 minutes)
set -euo pipefail
cd /content
# Helper scripts get their own folder: next to the openwakeword clone, Python
# would import the clone's folder instead of the installed package.
mkdir -p /content/bev_scripts

# An isolated environment, so Colab's preinstalled packages can't clash and
# no runtime restart is needed.
pip -q install uv
uv venv -q --python 3.12 /content/bev-venv
export VIRTUAL_ENV=/content/bev-venv

cat > requirements.txt <<'EOF'
{REQUIREMENTS}EOF
uv pip install -q {TORCH}
uv pip install -q -r requirements.txt

# openWakeWord at a tested commit, with one fix: its --convert_to_tflite flag
# defaults to the string "False" (truthy), so it always tried a TensorFlow
# conversion and crashed after saving the model. We only need the ONNX file.
if [ ! -d openwakeword ]; then
  git clone -q https://github.com/dscripka/openWakeWord openwakeword
  git -C openwakeword checkout -q {OPENWAKEWORD_COMMIT}
  sed -i 's/        if args.convert_to_tflite:/        if args.convert_to_tflite is True:/' openwakeword/openwakeword/train.py
fi
uv pip install -q --no-deps -e ./openwakeword
mkdir -p openwakeword/openwakeword/resources/models
for f in melspectrogram.onnx embedding_model.onnx; do
  [ -f openwakeword/openwakeword/resources/models/$f ] || \\
    wget -q -O openwakeword/openwakeword/resources/models/$f \\
      https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$f
done

# The voice generator, pinned to the layout openWakeWord expects.
if [ ! -d piper-sample-generator ]; then
  git clone -q --branch {PIPER_SAMPLE_GENERATOR_TAG} https://github.com/rhasspy/piper-sample-generator
fi
[ -f piper-sample-generator/models/en_US-libritts_r-medium.pt ] || \\
  wget -q -O piper-sample-generator/models/en_US-libritts_r-medium.pt \\
    https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt

/content/bev-venv/bin/python -W ignore -c "import openwakeword.train, torch; print('Installed. CUDA available:', torch.cuda.is_available())"
""",
    ),
    code(
        "%%writefile /content/bev_scripts/download_data.py\n" + DOWNLOAD_DATA,
    ),
    code(
        """
#@title 4. Download training data (about 10 minutes) { display-mode: "form" }
!/content/bev-venv/bin/python -W ignore /content/bev_scripts/download_data.py
""",
        title=True,
    ),
    code(
        """
#@title 5. Write the training config { display-mode: "form" }
import json
config = {
    "model_name": MODEL_NAME,
    "target_phrase": [WAKE_PHRASE.strip().lower()],
    "custom_negative_phrases": [p.strip().lower() for p in SOUND_ALIKES.split(",") if p.strip()],
    "n_samples": N_SAMPLES,
    "n_samples_val": N_SAMPLES_VAL,
    "tts_batch_size": 50,
    "augmentation_batch_size": 16,
    "piper_sample_generator_path": "/content/piper-sample-generator",
    "output_dir": "/content/output",
    "rir_paths": ["/content/data/mit_rirs"],
    "background_paths": open("/content/data/background_dirs.txt").read().split(),
    "background_paths_duplication_rate": [1] * len(open("/content/data/background_dirs.txt").read().split()),
    "false_positive_validation_data_path": "/content/data/validation_set_features.npy",
    "augmentation_rounds": 1,
    "feature_data_files": {"ACAV100M_sample": "/content/data/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"},
    "batch_n_per_class": {"ACAV100M_sample": 1024, "adversarial_negative": 50, "positive": 50},
    "model_type": "dnn",
    "layer_size": 32,
    "steps": STEPS,
    "max_negative_weight": 1500,
    "target_false_positives_per_hour": 0.2,
    "target_accuracy": 0.7,
    "target_recall": 0.5,
}
# JSON is valid YAML, which is what the training script reads.
json.dump(config, open("/content/bev_wakeword.yaml", "w"), indent=2)
print(json.dumps({k: config[k] for k in ("target_phrase", "custom_negative_phrases", "n_samples", "steps")}, indent=2))
""",
        title=True,
    ),
    code(
        """
#@title 6. Generate voices saying the phrase (and sound-alikes) { display-mode: "form" }
# Re-run this cell if it stops part-way: it continues where it left off.
!cd /content && /content/bev-venv/bin/python -W ignore openwakeword/openwakeword/train.py --training_config /content/bev_wakeword.yaml --generate_clips
""",
        title=True,
    ),
    code(
        """
#@title 7. Add room echo and background noise { display-mode: "form" }
!cd /content && /content/bev-venv/bin/python -W ignore openwakeword/openwakeword/train.py --training_config /content/bev_wakeword.yaml --augment_clips
""",
        title=True,
    ),
    code(
        """
#@title 8. Train the model (about 20 minutes) { display-mode: "form" }
!cd /content && /content/bev-venv/bin/python -W ignore openwakeword/openwakeword/train.py --training_config /content/bev_wakeword.yaml --train_model
import os
path = f"/content/output/{MODEL_NAME}.onnx"
assert os.path.exists(path), "Training didn't produce a model. Check the output above for the error."
print("Model saved:", path)
""",
        title=True,
    ),
    code(
        "%%writefile /content/bev_scripts/check_model.py\n" + CHECK_MODEL,
    ),
    code(
        """
#@title 9. Check how well it works { display-mode: "form" }
!/content/bev-venv/bin/python -W ignore /content/bev_scripts/check_model.py /content/bev_wakeword.yaml
""",
        title=True,
    ),
    code(
        """
#@title 10. Download the model for BEV { display-mode: "form" }
from google.colab import files
files.download(f"/content/output/{MODEL_NAME}.onnx")
print("In BEV: Voice & Audio → Wake word → Engine: On-device → Load model.")
""",
        title=True,
    ),
]

nb = {
    "cells": cells,
    "metadata": {
        "accelerator": "GPU",
        "colab": {"provenance": [], "gpuType": "T4"},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 0,
}

out = HERE / "train_hey_bev.ipynb"
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
print("wrote", out)
