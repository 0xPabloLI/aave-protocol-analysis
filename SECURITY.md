# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.

## Automated Review on Pull Requests

Pull requests receive AI-assisted reviews via Factory Droid
(`.github/workflows/droid-review.yml`) when they are opened, marked ready for
review, or reopened. Subsequent pushes to an open PR do not re-trigger the
review, and reviews cannot run on PRs from forks (the workflow secret is
unavailable there).

- **Code review** — correctness and best-practice findings posted on the PR.
- **Security review** — a STRIDE/OWASP-oriented reviewer examining the diff.

To ask Droid a question or request a change at any time, comment `@droid` on
the PR or issue.
