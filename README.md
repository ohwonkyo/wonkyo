# Survey Web App

This project provides a minimal survey platform built with **React** and **Node.js/Express**. The backend stores data in Firebase Firestore when credentials are supplied, falling back to in-memory storage for local development. The frontend is a single page application that communicates with the Express API.

## Setup

1. Install server dependencies:
   ```bash
   cd server && npm install
   ```
2. Run the server:
   ```bash
   node index.js
   ```
The server will start on port `5000` by default.
3. Open `client/index.html` in your browser. When running the server locally the page will make requests to `/api` endpoints.
   - To answer a survey, supply `?id=<SURVEY_ID>` in the URL, e.g. `client/index.html?id=1`.
     This page is styled with a **mobile-first** approach so it works well on phones and tablets.

To enable Firestore storage, provide the path to a Firebase service account JSON file via the `FIREBASE_CRED_FILE` environment variable before starting the server.

To secure the admin API set the `ADMIN_TOKEN` environment variable. All admin
requests must include `Authorization: Bearer <token>`.

If you provide `HTTPS_KEY` and `HTTPS_CERT` the server will run under HTTPS.
Admins can restrict access by setting `ADMIN_IP_WHITELIST` to a comma separated
list of allowed IPs.

If you set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` the server can
send invitation emails. `BASE_URL` controls the link embedded in those emails.

User accounts created via the admin API store passwords using **bcrypt** for
security. CSRF protection is enabled and a token is sent in the `XSRF-TOKEN`
cookie.

## Features

- Create surveys and list existing ones
- Submit responses for a survey
- Optional Firestore persistence for scaling or real-time access
- Simple React UI with Bootstrap styling
- Responsive layout for desktop, tablet and mobile devices
- Built-in templates for quick survey creation
- Block-style question editor with drag-and-drop ordering and an optional
  advanced mode for configuring question types
- Preview the survey from the builder to check the respondent view
- Simple admin dashboard (`client/index.html?admin=1`) showing survey, user and
  stats management
- API endpoints under `/api/admin` for full survey lifecycle control and
  external database configuration
- HTTPS support, IP whitelisting for admins and bcrypt-hashed passwords
- CSRF protection and basic XSS filtering when storing answers
- Sensitive fields like emails are hashed before storage
- Surveys can be shared via public URLs, invite-only tokens, email delivery,
  or downloadable QR codes
- Optional collaborator invitations for shared survey editing
- Optional respondent management with filtering when `manageRespondents` is enabled
- Optional PDF certificates for participants when `certificate.enabled` is set

This is a lightweight foundation that can be deployed to free services such as Vercel or Firebase Hosting.

## Localization

Survey titles and questions are stored with language codes so that text can be added in multiple languages. The current UI uses a small i18n dictionary and shows Korean labels by default. Add more entries to `client/index.html` and include other language keys when creating surveys to extend support.

## Survey builder

Open `client/index.html` in your browser to create surveys. Questions are added as individual blocks that you can reorder via drag-and-drop. Enable the **고급 모드** checkbox to choose question types such as short answer or multiple choice and to add options. Leaving it unchecked offers a simpler text-only mode.
Click the **미리보기** button to preview the survey exactly as respondents will see it.

## Distribution options

When creating a survey set `visibility` to one of `public`, `private` or `invite`.
`public` surveys are open to anyone via the shared link.
`private` surveys require respondents to be logged in.
`invite` surveys require a valid token. Admins can generate tokens via `POST /api/admin/surveys/:id/invite` which will return the token and optionally send it via email if SMTP is configured.

Participants can open `client/index.html?id=<ID>&token=<TOKEN>` when a token is required or simply `?id=<ID>` for public surveys. A QR code for any survey can be downloaded from `/api/surveys/:id/qr` (optionally with `?token=...`).

## Partial response saves

Surveys support optional partial saving. When creating a survey send `allowPartial: true|false` (defaults to `true`). Logged‑in respondents can press the **임시 저장** button to store their current answers and resume later. Saved progress is tied to the user account and can be retrieved from `/api/surveys/:id/partial`.

## Duplicate response prevention

When creating a survey you may set `duplicateCheck` to control how repeated submissions are blocked:

- `none` – allow multiple responses (default)
- `user` – only logged-in users may respond once
- `email` – participants enter an email, receive a code via `/api/surveys/:id/requestCode`, and can submit once per verified email
- `cookie` – a browser cookie marks completion
- `ip` – the client IP address may submit only once

The React form displays the relevant input fields (email/code) and ensures an Authorization header is sent when required.

## Respondent management

When creating a survey set `manageRespondents: true` to record respondent emails and invite tokens. Admins may view the respondent list via `GET /api/admin/surveys/:id/responses` and filter results with `start`, `end` and `contains` query parameters.

## Completion actions

Each survey can define what happens after a participant submits an answer.

- `completionMessage` – text shown after submission
- `redirectUrl` – if provided the browser navigates to this link
- `sendConfirmation` – when true and an email is available a confirmation message is emailed
- `rewardPoints` – numeric value logged as a reward for logged‑in users
- `certificate.enabled` – generate a PDF certificate on completion
- `certificate.nameField` – index of the question used for the participant name
- `certificate.issuer` – text displayed as the issuer on the certificate

## Closing surveys

Surveys can automatically stop collecting responses using one or more rules:

- `closeDate` – ISO timestamp after which the survey rejects new answers
- `responseLimit` – maximum number of responses allowed
- `closed` – when set to `true` the survey is manually closed via the admin API

These options are provided when creating a survey and can be modified later via
`PUT /api/admin/surveys/:id`. Respondents attempting to view a closed survey
receive a `closed` error message.

## Real-time response stats

When creating a survey send `showRealtime: true` to allow anyone to check
current response counts while the survey is open. The endpoint
`GET /api/surveys/:id/stats` returns the total number of responses and a simple
breakdown of answers per question. If `showRealtime` is `false` this endpoint is
restricted to admins.

## Survey reuse

Surveys can be copied or saved as templates for future use.

- `POST /api/admin/surveys/:id/copy` – duplicate a survey including all
  questions and settings.
- `POST /api/admin/surveys/:id/template` – store an existing survey as a new
  template.

Survey authors can also start from predefined templates. The `/api/templates`
endpoint lists available templates. Send `templateId` when creating a survey to
copy its questions. Admins may manage templates via `/api/admin/templates` CRUD
routes. Default templates include a satisfaction survey, an event signup form
and a market research questionnaire.

## Collaborative editing

When creating a survey you may enable collaboration by sending `allowCollaborators: true`.
Admins can manage collaborators using the following endpoints:

- `GET /api/admin/surveys/:id/collaborators` – list collaborators
- `POST /api/admin/surveys/:id/collaborators` – add a collaborator with `email`, `userId` and `permission` (`read`, `edit`, or `results`)
- `DELETE /api/admin/surveys/:id/collaborators/:cid` – remove a collaborator

Collaborators are stored with their permission so that surveys can be co-edited or viewed by invited users.

## Version history

Each time an admin updates a survey via `PUT /api/admin/surveys/:id`, the
previous state is saved as a version. Records include who made the change, the
timestamp and which fields were updated.

Endpoints:

- `GET /api/admin/surveys/:id/versions` – list versions
- `GET /api/admin/surveys/:id/versions/<n>` – fetch a version
- `GET /api/admin/surveys/:id/versions/<a>/compare/<b>` – diff two versions
- `POST /api/admin/surveys/:id/versions/<n>/revert` – restore a version

New surveys start at version 1 with summary `created`.

## Exporting responses

Admins can download survey results or forward them to other systems.

- `GET /api/admin/surveys/:id/export/csv` – download responses as CSV
- `GET /api/admin/surveys/:id/export/xlsx` – download responses as an Excel file
- `GET /api/admin/surveys/:id/responses/:rid/certificate` – download a PDF certificate for a specific response
- If `GSHEET_ID` and `GSHEET_CRED_FILE` are provided the server automatically
  appends each response to the specified Google Sheet.
- When `WEBHOOK_URL` (and optional `WEBHOOK_TOKEN`) are set a POST request is
  sent for every new response so that external B2B systems can ingest data.
