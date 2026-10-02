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
| `formSchema` | JSON array of the non-file fields: `name`, `label`, `type`, `required` (only when true), `helpText` (only when present), `options` as `"value=Label"` strings (just `"value"` when both are equal) |
| `formState` | JSON object of the values currently in the form; an attached file appears as its file name |
| `missingRequiredFields` | JSON array of required field names still empty |
| `today` | the date and time spelled out, e.g. `Today is Friday, October 2, 2026 at 12:40 (Europe/Paris, UTC+02:00).` When the context is embedded in the text, this is the first line of the `[FORM CONTEXT]` block |
| `currentDate` | the visitor's local date, `YYYY-MM-DD` |
| `currentDateTime` | the visitor's local date and time, `YYYY-MM-DDTHH:mm` |
| `currentDayOfWeek` | e.g. `Friday` |
| `timeZone` | IANA zone and offset, e.g. `Europe/Paris (UTC+02:00)` |
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
- The schema is kept compact on purpose: it is sent on every turn, and its
  size drives the response time. Measured on 2026-10-02 with the context
  embedded in the message text: about 40-45 s per turn with the full schema
  (3,560 characters), 22-32 s with a compact one (1,379), 12-17 s with none.
- File fields are not in the schema and are never set by the agent, which
  cannot analyze files. The customer uses the paperclip button. For each file,
  the chat shows a card (thumbnail for images) with one button per compatible
  file field, filled ones marked "replace", plus Cancel. Nothing is sent to the
  agent: the file name shows up in `formState` with the next message.
- Quick replies (`suggestions`) do not send anything. Each click toggles a
  selection, several can be selected, and they are sent together with the
  typed text, for example `Auto Accident, Vehicle. It happened last night.`
  The text box stays usable while the agent answers; only Send waits.
- The form is shown only when `complete` is `true` **and** no required field is
  empty. Otherwise the missing labels are listed in the chat.
- A reply that is not JSON is shown as plain text and applies no updates.

## AI Hub agent

Build it in Agent Builder as `Start → LLM → End`. Variables are declared in
**two different places**, and mixing them up is what silently drops the
context (see "How `context` reaches the agent" below).

**Agent definition → Variables panel**

- **Input Variables**: `request` only. This comma-separated field lists the
  arguments the chatbot's Supervisor (an LLM) must fill in when it calls the
  agent. The Supervisor only ever sees the customer's text, so any other name
  listed here receives an empty string, and that empty value then blocks the
  real `context` value.
- **Output Variable**: `response`.

**LLM node → Input Variables**: every value the prompt uses. These are read
from the workflow context, where the message `context` keys land directly.

```json
[
	{"name": "request", "type": "string"},
	{"name": "formSchema", "type": "string"},
	{"name": "formState", "type": "string"},
	{"name": "missingRequiredFields", "type": "string"},
	{"name": "today", "type": "string"},
	{"name": "currentDate", "type": "string"},
	{"name": "currentDateTime", "type": "string"},
	{"name": "currentDayOfWeek", "type": "string"},
	{"name": "timeZone", "type": "string"},
	{"name": "locale", "type": "string"}
]
```

**LLM node → Output Variables**: `[{"name": "response", "type": "string"}]`

**Description** (read by the chatbot's Supervisor):

```text
Claim declaration form-filling agent. Use this agent for EVERY customer
message, passing the customer's message unchanged as request. Its output is a
JSON object consumed by a program: return it to the customer verbatim, with no
rewording, no summary and no added text.
```

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

{{today}} Local date and time: {{currentDateTime}}, {{currentDayOfWeek}}, time zone {{timeZone}} (locale: {{locale}})
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
  long-text, select, date-time, number, boolean), required (present only when
  true), an optional helpText, and for select fields options written
  "value=Label", or just "value" when value and label are the same.
- The values currently in the form. This is the source of truth for what is
  already known: the customer may have edited the form directly. Attached
  files appear there as their file name.
- The required fields still empty before this turn.
- The customer's local date, time, day of the week and time zone (the line
  starting "Today is"). Always use it to resolve relative dates and times
  such as "yesterday evening", "this morning" or "last Monday", and write the
  result in local time.

HOW TO FILL THE FORM
1. Extract every value you can from the customer message. Do not ask again for
   something already in the form, unless the customer contradicts it; then
   update it.
2. Only use field names that exist in the schema. Respect each field's type:
   - select: exactly one option value, the part before "=" (or the whole
     option when it has no "=");
   - date-time: YYYY-MM-DDTHH:mm, local time;
   - number: digits with a dot as decimal separator, no currency symbol;
   - boolean: true or false;
   - text and long-text: plain text.
3. Never invent a value. If something is ambiguous or uncertain, ask.
4. Write claimSummary yourself: a short, factual title of at most 80
   characters. Write incidentDescription as a clear, factual account based on
   what the customer said. Use the customer's language.
5. Files are not part of the schema and never part of fieldUpdates: you
   cannot see or analyze them. When it is relevant (photos of the damage,
   police report, invoice or quote), invite the customer once to attach them
   with the paperclip button. Do not ask again once file names appear in the
   form values.

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
   suggestions. For a yes/no question, suggest "Yes" and "No". The customer
   may pick several suggestions and add text in the same message, for
   example "Auto Accident, Vehicle. It happened last night": read all of it.
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

- **How `context` reaches the agent.** Read in the AI Hub source
  (`liferay-aihub-workspace`, 2026-10-02):
  1. `MessageResourceImpl` invokes the `L_SUPERVISOR` agent with
     `input = context keys + request`.
  2. `SupervisorAgentImpl` gives the LangChain4j Supervisor only `request`
     (`invokeWithAgenticScope(request)`). The Supervisor never sees the
     `context` keys.
  3. `InternalAgentImpl.invoke` builds the sub-agent's workflow context in
     two passes. First, every name in the agent definition's Input Variables
     gets the value the Supervisor supplied, or `""` when it supplied none.
     Then every key of the original `input` is added, **unless the key is
     already there**.
  4. Each node reads its own Input Variables from that workflow context
     (`VariablesUtil.getInputVariables`), with `""` for a missing key.

  So a `context` key listed in the agent definition's Input Variables is
  overwritten by the Supervisor's empty argument. That is what the sentinel
  probe of 2026-10-02 showed: no value, and no literal `{{...}}` either. With
  only `request` listed there, the `context` keys pass straight through to the
  nodes. "Embed Form Context in Message Text" can then be turned off, which
  also takes the schema out of the Supervisor's own prompt and should cut the
  response time towards the 12-17 s measured without embedded context.
- **Verbatim output.** The Supervisor may rephrase the agent's answer. Check
  the raw `Chat Message Sent` payload in DevTools; if the JSON is reworded, make
  the description stricter. A non-JSON answer still shows in the chat, but it
  fills nothing.
- **Anonymous visitors.** The page is public. The element tries Cell
  on-behalf-of authentication and falls back to an anonymous conversation when
  no token is issued, which is expected for Guest. This agent uses no
  retrieval, so it needs no permission.
