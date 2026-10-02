# Claim Chat Assistant

`<claim-chat-assistant>` replaces a Liferay Form Container with a conversation
driven by an AI Hub chatbot. It fills the form from the answers, then shows the
completed form so the user can review and submit it.

This repository builds the element and publishes it on GitHub Pages, so it can
be used **without deploying a client extension**: you only create a *JS Import
Maps Entry* in the Liferay UI and paste its URL.

It is the companion repository of the *AI Hub Quick Start 5 — Using AI Hub
APIs* tutorial.

## Use it in Liferay

1. **Register the module.** Go to *Applications → Client Extensions → New →
   JS Import Maps Entry*:
   - **Bare Specifier**: `claim-chat-assistant`
   - **JavaScript URL**: a versioned URL, for example
     `https://fabian-bouche-liferay.github.io/ai-hub-claim-chat-assistant/v1.0.0/claim-chat-assistant.js`

   All the published versions are listed on
   [the GitHub Pages index](https://fabian-bouche-liferay.github.io/ai-hub-claim-chat-assistant/).
   Prefer a versioned URL to `latest/`, which changes with every commit on
   `main`.
2. **Import the fragment.** Download `claim-chat-fragments.zip` from the
   [latest release](https://github.com/fabian-bouche-liferay/ai-hub-claim-chat-assistant/releases/latest)
   and import it in *Design → Fragments → Import*. It adds the *Claim Chat
   Assistant* collection with the *Claim Chat Form Wrapper* fragment.
3. **Build the page.** Drop the *Claim Chat Form Wrapper* fragment on a page,
   then drop a Form Container mapped to your Object into its drop zone.
4. **Configure the fragment** with the external reference code of your AI Hub
   chatbot (see [AI Hub agent](#ai-hub-agent) below).

Reload the page after creating the import maps entry: the browser only picks
up a new import map on a full page load.

## What is in this repository

| Path | Content |
| --- | --- |
| `src/claim-chat-assistant.js` | The custom element: plain ES module, no dependency |
| `fragments/claim-chat-assistant/` | The fragment collection, in Liferay's export format |
| `scripts/build-site.mjs` | Builds the GitHub Pages site into `site/` |
| `.github/workflows/publish.yml` | Builds and deploys the site, creates the releases |

- **UI**: rendered in light DOM with ClayUI markup only (`card`, `sticker`,
  `progress-group`, `label`, `btn`, `input-group`, `form-control`,
  `loading-animation`, `alert`) and icons from the page's own Clay spritemap,
  so it follows the theme and Style Book. The only CSS it adds is layout
  (log height, bubble width), plus `text-transform: none` on the field labels.
- **Fragment**: `claim-chat-form-wrapper` holds the element and an
  `<lfr-drop-zone id="form-zone">` for the Form Container. Its JavaScript
  imports `claim-chat-assistant` through the import map, outside of edit mode
  only. Configuration: chatbot ERC, AI Hub URL, welcome message, and "Embed
  Form Context in Message Text".
- With no chatbot ERC, or when the drop zone holds no form (for example the
  success message after submission), the element does nothing and the native
  form stays visible. If the module cannot be loaded, the fragment shows the
  native form too.

## Releasing a new version

1. Commit the change on `main`. The workflow deploys it under `latest/`.
2. Tag it and push the tag:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

   The workflow publishes it under `v1.1.0/` and creates a GitHub Release with
   `claim-chat-assistant.js`, its source map and `claim-chat-fragments.zip`.

Every deployment rebuilds every `v*` tag from git, so the URLs of older
versions keep working. GitHub Pages caches files for about 10 minutes.

The JavaScript is served from GitHub Pages, not from the Release: release
assets are downloaded as `application/octet-stream`, and browsers refuse to
execute an ES module served with that type.

### One-time GitHub setup

- *Settings → Pages → Build and deployment → Source*: **GitHub Actions**.
- *Settings → Environments → github-pages → Deployment branches and tags*: add
  a tag rule `v*`. By default only `main` may deploy to Pages, so a tag push
  would otherwise fail at the deploy step.

### Build locally

```bash
npm install
npm run build   # writes site/, one folder per v* tag plus latest/
```

## How the form is read

For every `[data-field-name^="ObjectField_"]` wrapper in the drop zone, the
element reads:

| Property | Source |
| --- | --- |
| `name` | `data-field-name` without `ObjectField_` |
| `type` | `data-field-type` (`text`, `long-text`, `select`, `date-time`, `number`, `boolean`, `file`) |
| `label` | first id in the control's `aria-labelledby` |
| `helpText` | the control's `aria-describedby` |
| `required` | `required` / `aria-required` |
| `options` | `[role="option"]` items (`data-option-value`, `data-option-label`) |

## Message protocol

Each message is sent to AI Hub with this `context`. AI Hub merges its keys
flat into the agent's input map, next to `request`:

| Key | Content |
| --- | --- |
| `formSchema` | JSON array of the fields described above, plus `format` hints |
| `formState` | JSON object of the values currently in the form |
| `missingRequiredFields` | JSON array of required field names still empty |
| `currentDateTime` | the visitor's local date and time, `YYYY-MM-DDTHH:mm` |
| `locale` | page language |

The agent must answer with one JSON object (Markdown code fences are tolerated):

```json
{
	"message": "Conversational text shown to the customer",
	"fieldUpdates": {"claimType": "waterDamage", "incidentDateTime": "2026-09-30T18:45"},
	"questions": ["Follow-up question shown as its own bubble"],
	"suggestions": ["Quick reply 1", "Quick reply 2"],
	"complete": false
}
```

- A `select` value may be an option value or its label. Numbers are
  normalized, so `1 250,50` becomes `1250.5`. A date without a time gets
  `12:00`.
- File fields are never set by the agent, which only receives text. The
  customer uses the paperclip button. For each file, the chat shows a card
  (thumbnail for images) with one button per compatible file field, filled
  ones marked "replace", plus Cancel. Once every file is placed or skipped,
  the element sends one message such as `I have attached rear.jpg as Damage
  Photo 2, invoice.pdf as Supporting Document.`
- The form is shown only when `complete` is `true` **and** no required field is
  empty. Otherwise the missing labels are listed in the chat.
- A reply that is not JSON is shown as plain text and applies no updates.

## AI Hub agent

Build it in Agent Builder as `Start → LLM → End`.

**Input Variables**

```json
[
	{"name": "request", "type": "string"},
	{"name": "formSchema", "type": "string"},
	{"name": "formState", "type": "string"},
	{"name": "missingRequiredFields", "type": "string"},
	{"name": "currentDateTime", "type": "string"},
	{"name": "locale", "type": "string"}
]
```

**Output Variables**: `[{"name": "response", "type": "string"}]`

**Description** (read by the chatbot's Supervisor):

```text
Claim declaration form-filling agent. Use this agent for EVERY customer
message.

Inputs to pass on every invocation:
- request: the customer's message, unchanged;
- formSchema, formState, missingRequiredFields, currentDateTime, locale:
  copy each of these context values exactly as you received them, without
  summarizing, reformatting or omitting any of them. They are JSON strings
  describing the form and must reach this agent intact.

Its output is a JSON object consumed by a program: return it to the customer
verbatim, with no rewording, no summary and no added text.
```

The chatbot's Supervisor receives the message `context` and forwards it to
this agent as additional Input Variables. That is why the description names
each variable to pass, and why the agent declares the same names in its own
Input Variables.

**User Message**

```text
Customer message:
{{request}}

Form schema (JSON):
{{formSchema}}

Values currently in the form (JSON):
{{formState}}

Required fields still empty before this turn (JSON):
{{missingRequiredFields}}

Customer local date and time: {{currentDateTime}} (locale: {{locale}})
```

**Prompt**

```text
You are the claim declaration assistant of an insurance claims portal. You
help a customer declare a claim through a natural, empathetic conversation and
you fill in a web form on their behalf. You never submit the form: once
everything is collected, the customer reviews it and submits it.

INPUTS
- The customer message.
- The form schema: one entry per field with name, label, type (text,
  long-text, select, date-time, number, boolean, file), required, an optional
  format, options (select only: value and label) and helpText.
- The values currently in the form. This is the source of truth for what is
  already known: the customer may have edited the form directly.
- The required fields still empty before this turn.
- The customer's local date and time, to resolve relative dates such as
  "yesterday evening" or "last Monday".

HOW TO FILL THE FORM
1. Extract every value you can from the customer message. Do not ask again for
   something already in the form, unless the customer contradicts it; then
   update it.
2. Only use field names that exist in the schema. Respect each field's type:
   - select: exactly one of options[].value;
   - date-time: YYYY-MM-DDTHH:mm, local time;
   - number: digits with a dot as decimal separator, no currency symbol;
   - boolean: true or false;
   - text and long-text: plain text.
3. Never invent a value. If something is ambiguous or uncertain, ask.
4. Write claimSummary yourself: a short, factual title of at most 80
   characters. Write incidentDescription as a clear, factual account based on
   what the customer said. Use the customer's language.
5. File fields (handledBy "attachmentButton") are never part of fieldUpdates.
   When it is relevant (photos of the damage, police report, invoice or
   quote), invite the customer once to attach them with the paperclip button.
   When the customer says files were attached, acknowledge it.

HOW TO LEAD THE CONVERSATION
6. Ask at most two questions per turn, grouped logically, for example the
   policy number and the policyholder name together. Put each question in
   questions only: message is a short acknowledgement or transition and
   must not contain or rephrase the questions, because both are displayed.
7. Ask first for the required fields still empty, taking this turn's own
   updates into account. Then offer the useful optional details: severity,
   estimated damage amount, third party involved, police report and its
   number, phone and preferred contact method. Do not insist on an optional
   detail the customer does not know or does not want to give.
8. When a question is about a select field, put the labels of its options in
   suggestions. For a yes/no question, suggest "Yes" and "No".
9. Be warm and concise. Acknowledge what happened before asking anything.
   Reply in the customer's language.
10. Set complete to true only when no required field is empty after your
    updates and the optional details have been offered. Then tell the customer
    that the form is ready, that they should review it and submit it.

OUTPUT
Answer with ONLY one JSON object, without Markdown and without any text before
or after it:
{
  "message": "<short acknowledgement, without the questions>",
  "fieldUpdates": {"<fieldName>": <value>},
  "questions": ["<follow-up question>"],
  "suggestions": ["<quick reply>"],
  "complete": false
}
Use {} and [] when there is nothing to report.
```

Attach only this agent to a chatbot, enable it, and copy its external
reference code into the `claim-chat-form-wrapper` fragment configuration, in
the Page Editor.

## Points to check with the real agent

- **Context reaching the agent.** Observed on 2026-10-02 with
  `CHATBOT_FORM_COMPLETION_FBO` / `AGENT_FORM_COMPLETION_FBO`: with the
  context sent only as `context`, the agent behaved as if it received nothing
  but `request`. It filled only the two field names quoted in the prompt,
  ignored the picklists, skipped the date, and asked again for a policy number
  already in `formState`. With "Embed Form Context in Message Text" turned on,
  the same turns filled `claimType`, `insuredAsset` and `incidentDateTime`, and
  stopped asking for known values. The SSE stream showed a single LLM node
  event and no Supervisor step. Keep the option on until the `context` →
  Input Variables path is confirmed in the agent's own trace.
- **Verbatim output.** The Supervisor may rephrase the agent's answer. Check
  the raw `Chat Message Sent` payload in DevTools; if the JSON is reworded, make
  the description stricter. A non-JSON answer still shows in the chat, but it
  fills nothing.
- **Anonymous visitors.** The page is public. The element tries Cell
  on-behalf-of authentication and falls back to an anonymous conversation when
  no token is issued, which is expected for Guest. This agent uses no
  retrieval, so it needs no permission.
