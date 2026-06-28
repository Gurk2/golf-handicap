# Golf Handicap Dashboard

A small React/Vite app for syncing Golf Ireland score history, showing official Golf Ireland handicap index history, and planning target scores for future rounds.

Golf Ireland is the source of truth. The app stores synced scores, synced handicap history, and settings in the browser with IndexedDB through Dexie.

## Features

- Sync rounds with date, course, gross score, course rating, slope rating, and PCC.
- Show the current handicap index from synced Golf Ireland data.
- Mark counting rounds, newest rounds, 9-hole rounds, and rounds excluded from the current 20-round window.
- Derive course/tee options from synced Golf Ireland rounds.
- Calculate course handicap for a selected course/tee.
- Plan target scores and projected index changes, including exceptional score reduction (ESR) markers.
- Show a handicap progression chart using official Golf Ireland handicap index values from synced history.

## Quick Start

Install dependencies:

```bash
npm install
```

Start the local dev server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Lint the code:

```bash
npm run lint
```

Preview the production build:

```bash
npm run preview
```

## How To Use The App

1. Authenticate with Golf Ireland.
   Sign in once; the sync panel collapses to your authenticated account.
2. Sync scores and index.
   Import rounds, tee data, differentials and official handicap history.
3. Plan the next card.
   Use synced course/tee data to see which future scores would count, cut, or trigger ESR.

9-hole handling comes from synced holes/course metadata or a score under `70`. Scores under `70` are assumed to be 9-hole rounds and are doubled to an 18-hole equivalent differential.

## WHS Model Notes

This app is a practical dashboard, not an official handicap authority. Golf Ireland remains the source of truth for handicap index history.

The main calculation is:

```text
score differential = (score - course rating - PCC) * 113 / slope
local planning index = average of the best 8 differentials from the most recent 20
```

For synced rounds marked as 9 holes, or entered with a score under `70`, the app doubles the calculated differential when it needs a local differential. The target planner projects one additional round against the current rolling set of differentials, while the tracker uses official Golf Ireland handicap index values.

Course handicap uses:

```text
round((handicap index * slope / 113) + (course rating - par))
```

When par is missing, the rating-minus-par adjustment is skipped.

## Data Storage

Data lives in the browser's IndexedDB database named `GolfHandicap`.

Dexie tables are defined in `src/db.js`:

- `rounds`: Golf Ireland score cache.
- `courses`: legacy table cleared by the current migration; course options are derived from synced rounds.
- `handicapHistory`: Golf Ireland handicap history cache.
- `settings`: browser-local settings such as target handicap.

The current database migration removes old manually-entered rounds and clears saved courses. Successful Golf Ireland sync replaces the local rounds and handicap-history caches.

Because storage is browser-local, users should use the same browser/profile to keep their synced cache and settings. Clearing site data will remove cached scores and credentials.

## Golf Ireland Sync

The public DotGolf ISV API requires signed client credentials, so this app uses your normal Golf Ireland username/password through a private server-side sync endpoint.

The settings box stores these values locally in IndexedDB:

- `login`: your Golf Ireland website username, membership number, or email.
- `password`: your Golf Ireland website password.

Configure the private endpoint with:

```bash
VITE_GOLF_IRELAND_SYNC_URL=http://localhost:8787/sync-golf-ireland
```

The app sends:

```json
{
  "login": "your-login",
  "password": "your-password",
  "pageUrl": "https://www.golfireland.ie/my-scores",
  "scoresUrl": "https://www.golfireland.ie/api/Score/GetMyScores"
}
```

The included `sync-server` logs in with Playwright, then captures or calls Golf Ireland's POST-only `https://www.golfireland.ie/api/Score/GetMyScores` endpoint using the authenticated browser session.

Run it locally:

```bash
cd sync-server
npm install
npm run install-browser
npm start
```

The endpoint returns either an array of scores or an object with `scores`/`rounds`. Scores can use either the app's generic fields or DotGolf-style fields such as `playedAtLocal`, `adjustedGrossScore`, `marker.course`, `marker.name`, `marker.courseRating`, `marker.slope`, `holesPlayed`, `pcc`, and `scoreDifferentialPostPCC`.

It may also return `handicapHistory`, `handicapIndexes`, `history`, or a current `handicap` object with an `index`.

Each sync replaces the local Golf Ireland cache. Duplicate returned scores are collapsed using `scoreUID` when present, otherwise by date/course/score/rating/slope.

## Project Structure

```text
src/App.jsx     Main React UI and handicap/planner calculations
src/db.js       Dexie database schema and migrations
src/main.jsx    React entry point
src/index.css   Global CSS variables and base styles
public/         Static icons
```

Most behavior currently lives in `src/App.jsx`. If this grows, good future extraction points are calculation helpers, form components, and table row components.

## Contributing Notes

- Keep changes small and aligned with the current single-page app shape.
- Prefer existing helpers such as `differential`, `handicap`, `scoreForDifferential`, and `courseHandicapFor`.
- Be careful with Dexie migrations in `src/db.js`; never renumber existing versions after users have data.
- Run `npm run build` before sharing a change.
- Run `npm run lint` when touching JavaScript or React code.

## Known Limitations

- Golf Ireland sync requires a private server-side endpoint because browser-only website login is likely to be blocked by CORS/session protections.
- There is no manual fallback for adding rounds, courses, scores, or official handicap history.
- The calculations are intended for planning and personal tracking, not official handicap submission.
