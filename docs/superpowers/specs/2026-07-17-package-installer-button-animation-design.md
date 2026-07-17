# Package Installer Button Animation Design

## Goal

Make an active package installation visually obvious in the installer footer without changing installation behavior, progress reporting, or layout.

## Design

- While `isInstalling` is false, keep the existing `Download` icon and install label.
- While `isInstalling` is true, replace `Download` with the existing Lucide `Loader2` icon using Tailwind's `animate-spin` class.
- Preserve the current disabled state and the existing single-package and batch-progress labels.
- Do not add pulse effects, progress bars, timers, or new state.

## Testing

Add a focused source-level regression assertion that the footer button conditionally renders the spinning loader from `isInstalling`. Run the focused test first to prove it fails, then implement the minimal JSX change and run the full test and typecheck suites.
