package p;

import java.io.File;

public class App {
    String run(File file, String c, String b, Parser p) {
        return Util.load(file, c, b, p);
    }
}
