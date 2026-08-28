# Penguin index-quality quiz — questions

> Self-contained: reading this is enough to start.
> Repo: `FPMS-CCMS` (`/Users/shieng/Desktop/Projects/FPMS-CCMS`) · 10 questions · 2026-08-28
> The answers are deliberately NOT in this file (see index-quality-answers.md),
> so you cannot check yourself — answer honestly.

## Your task

Measure the quality of a local code index (Penguin). You are not changing code.

**Rules**

1. Answer using Penguin's MCP tools only, `knowledge_explore` first. No grep, no
   reading source files, no filling gaps from general knowledge — that would
   measure something other than the index.
2. Give the COMPLETE list per answer, with `file:line`. No examples-only, no "etc".
3. **If the tools cannot answer, say so.** This matters most: an honest "not in
   the index" is worth more than a lucky guess, because a guess hides the gap
   that is exactly what I am measuring. Leave it blank rather than fill it in.
4. If a tool reports `freshness=stale`, pass that on — do not present stale data
   as current.
5. Answer each question independently; do not infer later answers from earlier patterns.

**Output format** (one block per question)

```
## Q<n>
answer:
- path/to/file.ts:123 — symbolName
- ...
tool used: knowledge_explore("...")
confidence: high / medium / low — if low, say what the index was missing
```

---

## Q1 · callers

In FPMS-CCMS, which functions call `clearMultipleSearchStates` (defined in src/common/useSearchState.ts)? List every caller with its file.


## Q2 · callers

In FPMS-CCMS, which functions call `convertAction` (defined in src/utils/formUtils.ts)? List every caller with its file.


## Q3 · callers

In FPMS-CCMS, which functions call `fetchPlayerLevelsForDisplay` (defined in src/views/PlayerManagement/services/playerService.ts)? List every caller with its file.


## Q4 · callers

In FPMS-CCMS, which functions call `fetchProbabilityConfigItem` (defined in src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/hooks/useProbabilityConfigItemData.ts)? List every caller with its file.


## Q5 · callees

In FPMS-CCMS, what does `AmbassadorInfoForm` (src/views/AmbassadorManagement/AmbassadorInfo/AmbassadorInfoForm.tsx) call? Name each callee and where it lives.


## Q6 · callees

In FPMS-CCMS, what does `ArticlesForm` (src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx) call? Name each callee and where it lives.


## Q7 · callees

In FPMS-CCMS, what does `BestRouteSuggestionList` (src/views/GameManagement/BestRouteSuggestion/index.tsx) call? Name each callee and where it lives.


## Q8 · file_symbols

In FPMS-CCMS, list every function/class/method defined in src/components/ui/CustomInput.tsx.


## Q9 · file_symbols

In FPMS-CCMS, list every function/class/method defined in src/utils/navTreeUtils.ts.


## Q10 · file_symbols

In FPMS-CCMS, list every function/class/method defined in src/views/AmbassadorManagement/hooks/useAmbassadorVideoUpload.test.ts.

