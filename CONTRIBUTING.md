# Contributing to RubyMIK

Thanks for wanting to help — RubyMIK is one person's daily-driver tool shared in the
hope it helps you too. Bug reports, fixes, and features are all welcome.

## Ground rules

- **Open an issue first** for anything non-trivial, so we don't both build the same
  thing (or you don't build something that clashes with the safety model).
- **Keep the safety model intact.** Every configuration write goes through the
  safe-apply pipeline (snapshot → apply → verify reachability → auto-rollback →
  audit) and the management-path guards. A change that lets a user cut their own
  management path won't be merged.
- **Match the surrounding style**; run the tests (`cd server && npm test`) and the
  builds (`npm run build` at the root) before opening a PR. Keep the suite green.
- Small, focused PRs review fastest.

## Developer Certificate of Origin (DCO)

By contributing, you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
you wrote the contribution (or have the right to submit it) and you agree it is
provided under the project's **MIT license**. Sign off each commit with `-s`:

```
git commit -s -m "your message"
```

which appends a `Signed-off-by: Your Name <you@example.com>` line. That line, plus
the MIT license, keeps the project's ownership and licensing clean — contributions
are licensed to the project, and RubyMIK stays freely usable by everyone.

## Reporting bugs

Include your RubyMIK version (`/api/health` shows it), RouterOS version/model, what
you did, what you expected, and what happened. A config write that behaved
unexpectedly? The **Audit** page has the before/after — attach it (redact secrets).

Found a security issue? Email **ray@rubynet.co.za** directly rather than opening a
public issue.
