# Usage Guide: graph-assay

## What This Does

graph-assay checks whether a code-graph tool tells the truth about your code. Such a tool says which
piece of code calls which, and AI coding agents rely on those answers. When an answer is wrong, the
agent is wrong too, and it has no way of knowing.

graph-assay compares the tool's answers with sources the tool can't influence: the compiler's own
understanding of the code, the same tool run a different way, or an older version of the tool.
Wherever they disagree, there may be a bug worth reporting. Confirmed bugs become small examples
anyone can re-run.

## How to Use It

**Check which known bugs a build still has.** Run the fixture replay against the build. Every
known bug has a small example in the fixtures folder. The replay rebuilds each example's graph and
prints one verdict per bug:
- BROKEN: the bug is still there.
- FIXED: the right answer appears and the wrong one is gone.
- GUESSED: the wrong answer is there, but the tool itself marks it as a guess.
- CHANGED: the wrong answer is gone, but the right one doesn't appear either; look at it by hand.

Run this before a release, or after merging upstream changes. code-graph-rag's examples are a
separate set; point the replay at that folder to check them.

**Find new bugs in a real project.** Pick a project you have checked out, preferably in a language
the tool changed recently, and run the compiler comparison on it.
1. The result is a short table of disagreement types and how often each occurred. Skip the
   agreement row and the types the Technical Reference lists as normal.
2. Run triage. It ranks the remaining types by how much each would improve the tool's score if it
   were fixed, and says which ones match a bug already on file.
3. For each new candidate, use the call-site explainer. It shows what the tool and the compiler each
   said at that exact call, and how to re-run the comparison.
4. Confirm by reading the code that the compiler is right. Then shrink the problem to the smallest
   example that still shows it, and check that example against the tool's latest version.
5. Search the tool's existing issues, open and closed, before filing anything new.

**Review a change to the tool.** Index the same pinned projects with the build before the change
and the build after it, then compare. Edges that vanished but look correct point at a regression.
The build-diff workflow on GitHub does this for a pull request number.

**Check that the tool's switches really don't matter.** The execution-mode comparison indexes the
same code under each mode the tool documents as equivalent (native or WASM parsing, worker counts,
incremental sync) and reports every difference.

**Reproduce the benchmark tables.** The Docker reproduction builds a sealed environment, fetches the
public corpus at its pinned commits, measures both tools, and writes the tables with a manifest of
every input. The exact commands are in the Technical Reference under "Docker reproduction".

## What to Do When Something Breaks

- **"Almost every result says there was no match on that line"**: the comparison couldn't line the
  two sources up. Usually the compiler's index left out the project's test or source folders.
  Rebuild it with the right project settings.
- **"Every call in a Python project looks unresolved"**: the project keeps its code in a `src`
  folder that the indexer couldn't find. Use the Python wrapper, which handles that.
- **"The run stopped partway with no message"**: the machine probably ran out of memory. Run one
  project at a time.
- **"The Java indexer was refused"**: it builds the project, which runs that project's own code, so it
  only runs inside its sealed container.
- **"The check itself fails"**: run the self-check. It needs no tool build, and it names the
  failing test.

## FAQ

**Is every disagreement a bug?** No. Many are deliberate shortcuts in the tool, and some are
compiler limits. The Technical Reference lists which types are normal. The noise estimate measures
how often the compiler itself is wrong.

**Why not trust the tool's own tests?** They test what the authors thought of. The compiler knows the
code better than any hand-written test.

**Can I use it on my own projects?** Yes. The comparison runs on any TypeScript, JavaScript, Python,
Go or Java/Kotlin project you have checked out. It finds bugs in the code-graph tool, not in your
project.

**Can I add another tool?** Yes, by writing one adapter that indexes a folder and exports the
graph in the shared format. The Technical Reference describes the contract.

**Where are the scores?** Each tool's maintainers see their results before the tables are published.

See the [README](README.md) for an overview and the [Technical Reference](TECHNICAL.md) for details.
