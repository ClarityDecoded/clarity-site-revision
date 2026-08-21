# Site revision

Turns one row of client feedback (left through a "Suggest a change" markup
tool on a draft site preview) into a targeted before/after HTML edit for the
site's owner to review and approve. Edits exactly one element — the one the
client clicked — never the whole page.

It is the background half of a private client-portal app; this repo holds
only the AI generation step. There is no client data checked into this repo —
every run reads and writes a Supabase project the repo does not own, reached
through repository secrets, and the code here never prints a client's comment
or any page HTML to its own logs (see `site-revision/log-privacy.mjs`).

## Layout

    site-revision/     the pipeline (one real dependency: linkedom)
    .github/workflows  the dispatch + cron backstop

## Running it

Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `NVIDIA_API_KEY`.

    cd site-revision && npm install
    node generate.mjs                 # process everything pending
    FEEDBACK_ID=<uuid> node generate.mjs   # process just one row

## Logs

Actions logs on a public repo are public. This job's workflow sets
`PUBLIC_LOGS=1`, and `site-revision/log-privacy.mjs` redacts urls, email
addresses, quoted text and HTML tags from every log line before it's printed
— a backstop on top of the code already never printing a client's note or any
page HTML. Leave it on. `node site-revision/test-log-privacy.mjs` checks the
filter against real error shapes this pipeline produces, not invented ones.

## Licence

No licence — all rights reserved. Public for free CI, not as a template.
