# LinkedIn ICP Finder — n8n Workflow

Finds marketing decision-makers at companies actively hiring for email marketing roles.
Uses Google Custom Search API (legitimate, no direct LinkedIn scraping).

---

## How It Works

1. Searches Google for `site:linkedin.com/jobs "email marketing" "United States"`
2. Extracts company names from the results
3. For each company, searches Google for LinkedIn profiles matching:
   `"Head of Marketing" OR "VP Marketing" OR "Marketing Manager" OR "Growth Manager" OR "PMM"`
4. Writes results to Google Sheets: Company, First Name, Last Name, Title, LinkedIn URL, Signal, Date

---

## Setup — Step by Step

### Step 1 — Google Custom Search API Key

1. Go to https://console.cloud.google.com/
2. Create a new project (or use an existing one)
3. Enable the **Custom Search API**:
   - APIs & Services → Library → search "Custom Search API" → Enable
4. Create credentials:
   - APIs & Services → Credentials → Create Credentials → API Key
5. Copy the API key — this is your `GOOGLE_CSE_API_KEY`

**Free tier:** 100 queries/day. Each workflow run uses ~21 queries (1 job search + up to 20 people searches).

---

### Step 2 — Google Programmable Search Engine (CSE)

1. Go to https://programmablesearchengine.google.com/
2. Click **Add** to create a new search engine
3. In "Sites to search" enter: `linkedin.com`
4. Click Create
5. Click on your new engine → **Setup** → copy the **Search engine ID**
6. This is your `GOOGLE_CSE_ID`

Optional but recommended: Under "Search features" → turn on **Search the entire web**

---

### Step 3 — Google Sheets

1. Create a new Google Sheet at https://sheets.google.com
2. Name the first sheet tab: **ICP Results**
3. Add headers in row 1:
   `Company | First Name | Last Name | Title | LinkedIn URL | Signal | Found At`
4. Copy the Sheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`
5. This is your `GOOGLE_SHEET_ID`

---

### Step 4 — n8n Environment Variables

In n8n, go to **Settings → Environment Variables** and add:

| Variable | Value |
|---|---|
| `GOOGLE_CSE_API_KEY` | Your API key from Step 1 |
| `GOOGLE_CSE_ID` | Your Search Engine ID from Step 2 |
| `GOOGLE_SHEET_ID` | Your Sheet ID from Step 3 |

---

### Step 5 — Import the Workflow

1. In n8n, go to **Workflows → Import from file**
2. Upload `workflow.json`
3. Open the workflow
4. Connect the **Google Sheets** node:
   - Click the node → Credentials → Add new Google Sheets credential
   - Authenticate with the Google account that owns the Sheet

---

### Step 6 — Run

Click **Execute Workflow** (manual trigger).

Expected output: 20–80 rows in Google Sheets per run, depending on how many people Google has indexed per company.

---

## Customizing the Search

To change the job role or location, edit the **"Search LinkedIn Jobs"** node query:

```
site:linkedin.com/jobs "YOUR ROLE" "YOUR LOCATION"
```

Examples:
- `site:linkedin.com/jobs "content marketing" "United Kingdom"`
- `site:linkedin.com/jobs "growth marketing" "Germany"`
- `site:linkedin.com/jobs "product marketing" "Remote"`

---

## Rate Limits & Safety

- The workflow processes up to 20 companies per run
- Each run uses ~21 Google CSE queries (within free tier of 100/day)
- To run multiple times per day, upgrade to Google CSE paid tier ($5 per 1,000 queries)
- Results depend on what Google has indexed — coverage varies by company size

---

## Limitations

- Names and titles are extracted from Google snippet text — accuracy ~70-80%
- Some profiles may be outdated if Google's index is stale
- LinkedIn URLs are direct links to public profiles only
- Does not bypass LinkedIn login walls — only indexes public profile data
