class ScriptInfo:
    def __init__(self, create_app=None):
        self.create_app = create_app

    def load_app(self):
        if self.create_app is not None:
            return self.create_app()       # line 7
        return None
