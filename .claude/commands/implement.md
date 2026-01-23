---
allowed-tools: Bash(npm install:*), Bash(git add:*), Bash(git status:*), Bash(git commit:*), Read(*), Write(*), Edit(*)
description: Carries out development according to the specification
---

You are going to choose what to work on from `PRODUCT_SPEC.md`. Identify the outstanding work by searching for the 🟦 marker, and choose whichever such feature seems the most appropriate next step. You must choose only ONE feature.

Having chosen a feature to implement, you should read around related areas of the spec to make sure you understand the context.

- Implement that feature,
- Be sure to test the functionality against the real local dev server (see below),
- Update its entry in the specification to have the ✅ marker,
- Commit the changes to this git repository with a short, snappy description of the feature.

## Granularity of Features

**IMPORTANT** Some features in the spec may be quite large-grained, high level features. If you think a feature is elaborate and it should be tackled in smaller sub-tasks, you should expand the specification to describe those sub-tasks. Give each its own 🟦 marker, and remove the original parent feature's marker. You are responsible for improving the granularity of the spec appropriately! Then choose ONE of the new sub-tasks to work on.

## Testing

In additional, to preserve the robustness of the product, you should refer to `TESTING.md`. Extend the test to cover your newly implemented feature, and let

## What to do if there's nothing to do!

**IMPORTANT**: If there is no remaining work to implement, output the following exact string, and quit:

NO_REMAINING_WORK
