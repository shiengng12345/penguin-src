# Coverage policy

Git tracked files and policy-admitted untracked files are discovered independently of parser support. Binary, secret-like, ignored and oversized files remain in the coverage manifest with an exclusion reason. Parser failure cannot remove an admitted file from the source corpus.

The accounting invariant is `discovered = admitted + excluded + failed`; diagnostics must be shown for every empty result.
