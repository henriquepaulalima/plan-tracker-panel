# Search service migration

## Overview

Move product search from Postgres full-text to a dedicated search service.

## Plan

### 1. Provision the search cluster ✅

Three nodes on staging, one index per locale.

### 2. Write the indexing worker (in progress)

Listens to product change events and updates the index.

### 3. Backfill existing products

- [x] Export the catalog
- [ ] Bulk-load into the index
- [ ] Compare document counts

### 4. Switch the search endpoint behind a feature flag

Status: pending

### 5. ~~Build a custom ranking model~~

### 6. Decommission the Postgres search columns
