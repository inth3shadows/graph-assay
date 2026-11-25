namespace Demo;
public class Service { public void Run() { } }
public class Builder { public Service Services { get; } }
public static class Extensions { public static void InstallEntries(this Service service) { } }
