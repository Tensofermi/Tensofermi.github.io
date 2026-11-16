"""Adapt the reference engine to the browser tokenizer and public model catalog."""

import json
import sys
from types import ModuleType, SimpleNamespace

import browser_tokenizer


class Tokenizer:
    @classmethod
    def from_file(cls, _path):
        return cls()

    def encode(self, text, add_special_tokens=False):
        return SimpleNamespace(**json.loads(browser_tokenizer.encode_json(text)))

    def token_to_id(self, text):
        return browser_tokenizer.token_to_id(text)


tokenizers = ModuleType("tokenizers")
tokenizers.Tokenizer = Tokenizer
sys.modules["tokenizers"] = tokenizers

PUBLIC_MODEL = "deepseek-official/deepseek-flash"
models = ModuleType("models")
models.CATALOG = {PUBLIC_MODEL: {"api_model": "deepseek-flash", "adapter": "dsv41"}}
sys.modules["models"] = models

import engine
import trajectory_import


def dispatch(action, payload):
    body = json.loads(payload)
    if action == "preview":
        result = engine.analyze(body["messages"], body.get("tools"), body["thinking"], body["effort"])
    elif action == "generated":
        result = engine.generated_tokens(body)
    elif action == "import":
        result = trajectory_import.convert(body["data"], body["source"])
        if not result["model_key"] and result["model_name"].lower().endswith("deepseek-v4.1-flash"):
            result.update(model_key=PUBLIC_MODEL, tokenizer_available=True)
        result.update(next_step=None, total_steps=result["loaded_steps"])
    elif action == "field":
        result = {"tokens": trajectory_import.tokenize_field(PUBLIC_MODEL, body["text"])}
    else:
        raise ValueError("未知的浏览器参考操作")
    return json.dumps(result, ensure_ascii=False)
