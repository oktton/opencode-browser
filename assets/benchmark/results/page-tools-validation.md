# page-tools validation — real pages

Run 2026-09-06 05:01 · headless Chrome · 18 sites
Helpers: `__data`, `__records`, `__skeleton`, `__recordsBlind`.

## Method

Each site is anchored the way the agent would anchor it — `__find("<a known item>")` where a stable
seed string exists, otherwise the repeated link position carrying the most text (content lists, not nav).
Ground-truth counts exist for only 6 sites, so correctness is judged mostly by invariants that must
hold for *any* correct record set:

| invariant | catches |
|---|---|
| **disj** — no record nests inside another | picking a container level instead of the record level |
| **uniq** — records carry distinct text | spacer/duplicate rows swept in |
| **stab** — anchoring on a different member of the same group returns the same size | anchor-dependent (i.e. unreliable) grouping |
| **homog** — all records share a tag | mixed row types (the HN 60-vs-30 bug) |
| **blind** — `__recordsBlind()` with no anchor | independent second opinion |

## Results

| Site | Structure | recs | want | disj | uniq | stab | homog | blind | anchor | __data | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| news.ycombinator.com/ | table rows, half unclassed | **30** | 30 | ✓ | 100% | ✓ | ✓ | 30 | auto | 2B | 3 |
| quotes.toscrape.com/ | semantic cards + microdata | **10** | 10 | ✓ | 100% | ✗ | ✓ | 10 | seed | 1912B | 3 |
| books.toscrape.com/ | product grid (li) | **20** | 20 | ✓ | 100% | ✓ | ✓ | 20 | seed | 22B | 2 |
| www.scrapethissite.com/pages/simple/ | country divs | **250** | 250 | ✓ | 100% | ✓ | ✓ | 87 | seed | 164B | 19 |
| www.scrapethissite.com/pages/forms/ | data table rows | **25** | 25 | ✓ | 84% | ✗ | ✓ | 5 | seed | 172B | 4 |
| en.wikipedia.org/wiki/List_of_largest_cities | wiki sortable table | **85** | — | ✓ | 100% | ✗ | ✓ | 106 | seed | 704B | 9 |
| developer.mozilla.org/en-US/docs/Web/API | docs index list | **571** | — | ✓ | 100% | ✓ | ✓ | 35 | seed | 294B | 28 |
| webscraper.io/test-sites/e-commerce/allinone | bootstrap cards (2) | **3** | 3 | ✓ | 100% | ✓ | ✓ | 4 | seed | 1049B | 1 |
| github.com/trending | repo list, deep nesting | **29** | — | ✓ | 97% | ✗ | ✓ | 16 | auto | 602B | 3 |
| www.bbc.com/news | news cards, heavy nesting | **20** | — | ✓ | 100% | ✓ | ✓ | 10 | auto | 1742B | 2 |
| text.npr.org/ | minimal semantic html | **20** | — | ✓ | 100% | ✓ | ✓ | 20 | auto | 2B | 3 |
| www.allrecipes.com/recipe/23600/worlds-best- | recipe detail, ld+json | **2** | — | ✓ | 100% | ✗ | ✓ | 20 | auto | 6085B | 1 |
| www.allrecipes.com/search?q=lasagna | recipe listing | **10** | — | ✓ | 100% | ✓ | ✓ | 24 | auto | 564B | 1 |
| www.apple.com/shop/buy-mac/macbook-pro | apple config page | **63** | — | ✓ | 100% | ✓ | ✓ | 25 | auto | 2365B | 3 |
| stackoverflow.com/questions | question list | `EVAL_FAIL` | — | | | | | | | — | |
| pypi.org/search/?q=http | package search results | `EVAL_FAIL` | — | | | | | | | — | |
| www.ebay.com/sch/i.html?_nkw=keyboard | marketplace listing | `NO_ANCHOR` | — | | | | | | | 2 | |
| www.reddit.com/r/programming/ | web components | `EVAL_FAIL` | — | | | | | | | — | |

## Summary

- reached: **14/18** · blocked/failed: 4
- all invariants passed: **12/14**
- disjoint 14/14 · stable 9/14 · homogeneous 14/14 · uniq≥80% 14/14
- ground truth hit: 6/6
- `__data` over 8KB output cap: 0/14
- `__records` median 3 ms · `__skeleton` median 252 B

## Sites failing an invariant

### https://github.com/trending

29 × `LI.-` · blind 16 · disj true · uniq 97% · stab false · homog true
anchor: "GitHub CopilotWrite better code with AI"

```
li
  a.Primer_Brand__Link-module__Link___lF11y.Primer_Brand__Link-m href
    span.Primer_Brand__Text-module__Text___XeGJJ.Primer_Brand__Text-m
      span.Primer_Brand__Text-module__Text___XeGJJ.Primer_Brand__Text-m  "GitHub Copilot"
      span.Primer_Brand__Text-module__Text___XeGJJ.Primer_Brand__Text-m  "Write better code with AI"
```

### https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/

2 × `UL.comp` · blind 20 · disj true · uniq 100% · stab false · homog true
anchor: "homemade lasagna noodles"

```
ul#mntl-sc-block_9-0.comp.mntl-sc-block.mntl-sc-block-html
  li  ": This super meaty lasagna has sweet Italian sausage lean ground beef."
    strong  "Meat"
    em  "and"
  li  ": An onion and two cloves of garlic are cooked with the meat to add tons of flav"
    strong  "Onion and garlic"
```

## Unreachable sites

- `https://stackoverflow.com/questions` → **EVAL_FAIL** · TypeError: Cannot read properties of null (reading 'innerText')
- `https://pypi.org/search/?q=http` → **EVAL_FAIL** · TypeError: Cannot read properties of null (reading 'innerText')
- `https://www.ebay.com/sch/i.html?_nkw=keyboard` → **NO_ANCHOR** · title="Error Page | eBay" bodyLen=192
- `https://www.reddit.com/r/programming/` → **EVAL_FAIL** · TypeError: Cannot read properties of null (reading 'innerText')

## `__data` per site

- `news.ycombinator.com/` → (none) · 2B
- `quotes.toscrape.com/` → CreativeWork, CreativeWork, CreativeWork, CreativeWork, CreativeWork · 1912B
- `books.toscrape.com/` → PageMeta · 22B
- `www.scrapethissite.com/pages/simple/` → PageMeta · 164B
- `www.scrapethissite.com/pages/forms/` → PageMeta · 172B
- `en.wikipedia.org/wiki/List_of_largest_cities` → Article, PageMeta · 704B
- `developer.mozilla.org/en-US/docs/Web/API` → PageMeta · 294B
- `webscraper.io/test-sites/e-commerce/allinone` → SiteNavigationElement, Product, Product, Product, PageMeta · 1049B
- `github.com/trending` → PageMeta · 602B
- `www.bbc.com/news` → WebPage, PageMeta · 1742B
- `text.npr.org/` → (none) · 2B
- `www.allrecipes.com/recipe/23600/worlds-best-` → Recipe,NewsArticle, PageMeta · 6085B
- `www.allrecipes.com/search?q=lasagna` → PageMeta · 564B
- `www.apple.com/shop/buy-mac/macbook-pro` → Product, BreadcrumbList, FAQPage, PageMeta · 2365B
