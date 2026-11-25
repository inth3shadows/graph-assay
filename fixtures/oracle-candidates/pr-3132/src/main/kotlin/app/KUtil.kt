package app

object KUtil {
    fun load(f: String, c: String): String = c
    fun load(f: String, c: String, b: String, p: Int): String = b
    fun load(f: Int, c: String, b: String, p: Int): String = b
}

class KLoader {
    fun run(f: String, c: String, b: String, p: Int): String {
        return KUtil.load(f, c, b, p)
    }
}
