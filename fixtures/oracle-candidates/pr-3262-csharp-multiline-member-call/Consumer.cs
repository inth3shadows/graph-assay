namespace Demo;
public class Consumer {
  private Builder _builder;
  public Builder Current { get; }
  public void Field() { _builder.Services.InstallEntries(); }
  public void Property() { Current.Services.Run(); }
  public void Parameter(Builder
    builder) { builder.Services.Run(); }
  public void Split() { _builder
    .Services
    .InstallEntries(); }
}
