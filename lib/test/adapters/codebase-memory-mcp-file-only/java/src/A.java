package p;

class A {
  void run() {}
  static class Inner {
    void run() {}
  }
}

class B {
  void run() {}
  void other() {
    Runnable r = new Runnable() { public void run() {} };
  }
}
