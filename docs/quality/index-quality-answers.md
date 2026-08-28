# Penguin index-quality quiz — answer key

> For comparison only. **Do not hand this to the AI** (questions live in
> index-quality-quiz.md). Repo: `FPMS-CCMS` · 2026-08-28

## How to judge

Two different failures, kept apart:

| Comparison | Conclusion |
|---|---|
| AI answer != **index answer** | The agent did not use the tools properly. Its problem, not the index's. |
| **index answer** != **verify output** | A real index defect (missed or phantom edge). This is the one worth fixing. |

Reading verify output: extra ripgrep hits are often same-name symbols in other
scopes. Read them before calling anything a missed edge.

---

## Q1 · callers

**Question**: In FPMS-CCMS, which functions call `clearMultipleSearchStates` (defined in src/common/useSearchState.ts)? List every caller with its file.

**Index answer** (8)

- `src/views/AmbassadorManagement/AmbassadorManagement.tsx:AmbassadorManagement`
- `src/views/ConstantManagement/ConstantManagement.tsx:ConstantManagement`
- `src/views/ContentManagement/ContentManagement.tsx:ContentManagement`
- `src/views/GameManagement/GameManagement.tsx:GameManagement`
- `src/views/JackpotWinningArticleManagement/JackpotWinningArticleManagement.tsx:JackpotWinningArticleManagement`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/MarketingCampaignConfiguration.tsx:MarketingCampaignConfiguration`
- `src/views/MarketingManagement/MarketingManagement.tsx:MarketingManagement`
- `src/views/TrendingSearchManagement/TrendingSearchTabbedManagement.tsx:TrendingSearchTabbedManagement`

**Independent verification**

```bash
rg -n --no-heading '\bclearMultipleSearchStates\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS | grep -v 'src/common/useSearchState.ts'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output. Extra ripgrep hits are usually same-name symbols in other scopes — read them before calling them missing edges.

## Q2 · callers

**Question**: In FPMS-CCMS, which functions call `convertAction` (defined in src/utils/formUtils.ts)? List every caller with its file.

**Index answer** (1)

- `src/views/shared/registry/componentRegistry.ts:fetchTransformHandler`

**Independent verification**

```bash
rg -n --no-heading '\bconvertAction\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS | grep -v 'src/utils/formUtils.ts'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output. Extra ripgrep hits are usually same-name symbols in other scopes — read them before calling them missing edges.

## Q3 · callers

**Question**: In FPMS-CCMS, which functions call `fetchPlayerLevelsForDisplay` (defined in src/views/PlayerManagement/services/playerService.ts)? List every caller with its file.

**Index answer** (8)

- `src/views/GameManagement/GameFloor/GameFloorForm.tsx:run`
- `src/views/GameManagement/GameList/GameForm.tsx:run`
- `src/views/MarketingManagement/BannerV2/index.tsx:BannerV2List`
- `src/views/MarketingManagement/PopupV2/PopupV2Form.tsx:PopupV2Form`
- `src/views/MarketingManagement/PopupV2/index.tsx:PopupV2List`
- `src/views/dev/PopupDebug/PopupDebug.tsx:PreviewTab`
- `src/views/dev/debugLevelFilter.tsx:run`
- `src/views/shared/components/VipLevelSelect.tsx:VipLevelSelect`

**Independent verification**

```bash
rg -n --no-heading '\bfetchPlayerLevelsForDisplay\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS | grep -v 'src/views/PlayerManagement/services/playerService.ts'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output. Extra ripgrep hits are usually same-name symbols in other scopes — read them before calling them missing edges.

## Q4 · callers

**Question**: In FPMS-CCMS, which functions call `fetchProbabilityConfigItem` (defined in src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/hooks/useProbabilityConfigItemData.ts)? List every caller with its file.

**Index answer** (8)

- `src/views/MarketingCampaign/MarketingCampaignConfiguration/EventConfig/components/EventConfigForm.tsx:EventConfigForm`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfig/components/ProbabilityConfigForm.tsx:ProbabilityConfigForm`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/components/ProbabilityConfigItemList.tsx:ProbabilityConfigItemList`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/components/ProbabilityConfigItemList.tsx:handleSearch`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/components/ProbabilityConfigItemList.tsx:resetFields`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/hooks/useProbabilityConfigItemData.ts:handleBackFromDetails`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/hooks/useProbabilityConfigItemData.ts:handleDelete`
- `src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/hooks/useProbabilityConfigItemData.ts:multipleDelete`

**Independent verification**

```bash
rg -n --no-heading '\bfetchProbabilityConfigItem\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS | grep -v 'src/views/MarketingCampaign/MarketingCampaignConfiguration/ProbabilityConfigItem/hooks/useProbabilityConfigItemData.ts'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output. Extra ripgrep hits are usually same-name symbols in other scopes — read them before calling them missing edges.

## Q5 · callees

**Question**: In FPMS-CCMS, what does `AmbassadorInfoForm` (src/views/AmbassadorManagement/AmbassadorInfo/AmbassadorInfoForm.tsx) call? Name each callee and where it lives.

**Index answer** (10)

- `src/views/AmbassadorManagement/AmbassadorInfo/AmbassadorInfoForm.tsx:handleAddGame`
- `src/views/AmbassadorManagement/hooks/useAmbassadorData.ts:useAmbassadorData`
- `src/views/AmbassadorManagement/hooks/useAmbassadorFormUtils.ts:fetchProviderList`
- `src/views/AmbassadorManagement/hooks/useAmbassadorFormUtils.ts:useAmbassadorFormUtils`
- `src/views/AmbassadorManagement/hooks/useAmbassadorFormValidation.ts:saveToLocalStorage`
- `src/views/AmbassadorManagement/hooks/useAmbassadorFormValidation.ts:useAmbassadorFormValidation`
- `src/views/AmbassadorManagement/hooks/useAmbassadorFormValidation.ts:validateForm`
- `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx:useLocation`
- `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx:useParams`
- `src/views/shared/hooks/useComponentData.ts:useComponentData`

**Independent verification**

```bash
sed -n '/AmbassadorInfoForm/,/^}/p' /Users/shieng/Desktop/Projects/FPMS-CCMS/src/views/AmbassadorManagement/AmbassadorInfo/AmbassadorInfoForm.tsx
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q6 · callees

**Question**: In FPMS-CCMS, what does `ArticlesForm` (src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx) call? Name each callee and where it lives.

**Index answer** (10)

- `src/common/useSearchState.ts:getFieldValue`
- `src/utils/breadcrumbUtils.ts:generateBreadcrumbItems`
- `src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx:handleActionChange`
- `src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx:handleImageChange`
- `src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx:run`
- `src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx:saveToLocalStorage`
- `src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx:validateForm`
- `src/views/JackpotWinningArticleManagement/Articles/hooks/useArticlesData.ts:fetchSectionNameList`
- `src/views/JackpotWinningArticleManagement/Articles/hooks/useArticlesData.ts:useArticlesData`
- `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx:useLocation`

**Independent verification**

```bash
sed -n '/ArticlesForm/,/^}/p' /Users/shieng/Desktop/Projects/FPMS-CCMS/src/views/JackpotWinningArticleManagement/Articles/ArticlesForm.tsx
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q7 · callees

**Question**: In FPMS-CCMS, what does `BestRouteSuggestionList` (src/views/GameManagement/BestRouteSuggestion/index.tsx) call? Name each callee and where it lives.

**Index answer** (10)

- `src/common/common.ts:checkPermissions`
- `src/common/useDebounce.ts:useDebounce`
- `src/common/useSearchState.ts:useSearchState`
- `src/views/shared/hooks/useComponentData.ts:fetchComponent`
- `src/views/shared/hooks/useComponentData.ts:handleBackFromDetails`
- `src/views/shared/hooks/useComponentData.ts:multipleDelete`
- `src/views/shared/hooks/useComponentData.ts:navigateToAdd`
- `src/views/shared/hooks/useComponentData.ts:searchComponent`
- `src/views/shared/hooks/useComponentData.ts:useComponentData`
- `src/views/shared/registry/componentRegistryUtils.ts:getComponentValueByLabel`

**Independent verification**

```bash
sed -n '/BestRouteSuggestionList/,/^}/p' /Users/shieng/Desktop/Projects/FPMS-CCMS/src/views/GameManagement/BestRouteSuggestion/index.tsx
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q8 · file_symbols

**Question**: In FPMS-CCMS, list every function/class/method defined in src/components/ui/CustomInput.tsx.

**Index answer** (12)

- `CustomInput (function)`
- `CustomInputProps (interface)`
- `InputStatus (type)`
- `InputType (type)`
- `formValidator (function)`
- `handleBlur (function)`
- `handleChange (function)`
- `onChange (method)`
- `removeProps (function)`
- `renderInput (function)`
- `setElementCursorPosition (function)`
- `validateValue (function)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS/src/components/ui/CustomInput.tsx
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q9 · file_symbols

**Question**: In FPMS-CCMS, list every function/class/method defined in src/utils/navTreeUtils.ts.

**Index answer** (12)

- `NavTreeNode (interface)`
- `RouteConfigLike (interface)`
- `assignLevels (function)`
- `buildNavTree (function)`
- `buildNodesFromFlat (function)`
- `filtered (function)`
- `formatNavTreeAsString (function)`
- `getLabel (function)`
- `getNavTreeString (function)`
- `isDetailRoute (function)`
- `shouldIncludeInTree (function)`
- `visit (function)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS/src/utils/navTreeUtils.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q10 · file_symbols

**Question**: In FPMS-CCMS, list every function/class/method defined in src/views/AmbassadorManagement/hooks/useAmbassadorVideoUpload.test.ts.

**Index answer** (12)

- `MockXhr (class)`
- `a (function)`
- `abort (method)`
- `b (function)`
- `getCommonHeaders (method)`
- `getInternalPopupClient (method)`
- `makeVideo (function)`
- `okPresign (function)`
- `open (method)`
- `send (method)`
- `setRequestHeader (method)`
- `waitForXhr (function)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/FPMS-CCMS/src/views/AmbassadorManagement/hooks/useAmbassadorVideoUpload.test.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.
