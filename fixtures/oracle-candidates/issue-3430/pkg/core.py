# pkg/core.py
from .termui import prompt


class Option:
    def __init__(self, prompt=False):
        if prompt is True:
            prompt_text = "Value"
        else:
            prompt_text = prompt
        self.prompt = prompt_text

    def prompt_for_value(self):
        assert self.prompt is not None
        return prompt(self.prompt)
