/**
 * <claim-chat-assistant> — replaces a Liferay Form Container with a
 * conversational interface backed by an AI Hub chatbot, fills the form from
 * the conversation, then hands the completed form back to the user to submit.
 *
 * Attributes:
 *   ai-hub-url                        AI Hub origin (default https://ai.hub.liferay.com)
 *   chatbot-external-reference-code   AI Hub chatbot ERC (required)
 *   welcome-message                   First assistant bubble, shown without calling the agent
 *   embed-context-in-message          "true" to also append the form context to the message text
 *
 * The element looks for the form inside the closest [data-claim-chat-wrapper]
 * ancestor, in its [data-claim-chat-form-zone] child.
 *
 * Agent protocol — every reply must be a JSON object:
 *   {
 *     "message": "conversational text",
 *     "fieldUpdates": {"<fieldName>": <value>, ...},
 *     "questions": ["follow-up question", ...],
 *     "suggestions": ["quick reply", ...],
 *     "complete": false
 *   }
 */

const AI_HUB_API = '/o/ai-hub/v1.0';
const CELL_TOKEN_PATH = '/o/ai-hub-cell/v1.0/authorization-tokens';
const DEFAULT_AI_HUB_URL = 'https://ai.hub.liferay.com';
const DEFAULT_WELCOME =
	"Hello! I'm here to help you declare your claim. Tell me in your own words what happened.";
const FIELD_PREFIX = 'ObjectField_';
const REPLY_TIMEOUT_MS = 90000;

// Layout only: every visual style comes from the Clay CSS already loaded by
// the theme. Scoped to the element's tag, injected once per page.
const STYLES = `
	claim-chat-assistant {
		display: block;
	}
	claim-chat-assistant .claim-chat-log {
		height: min(480px, 60vh);
		overflow-y: auto;
	}
	claim-chat-assistant .claim-chat-bubble {
		max-width: 80%;
		white-space: pre-wrap;
	}
	claim-chat-assistant .claim-chat-input {
		max-height: 12rem;
		min-height: 2.5rem;
		overflow-y: hidden;
		resize: none;
	}
	claim-chat-assistant .claim-chat-progress {
		min-width: 12rem;
	}
	claim-chat-assistant .claim-chat-file {
		max-width: 80%;
	}
	claim-chat-assistant .claim-chat-file-text {
		min-width: 0;
	}
	claim-chat-assistant .claim-chat-thumbnail {
		height: 4.5rem;
		object-fit: cover;
		width: 6rem;
	}
	/* Clay labels capitalize their text; field values must stay verbatim. */
	claim-chat-assistant .claim-chat-update {
		max-width: 100%;
		text-transform: none;
	}
`;

function injectStyles() {
	if (document.getElementById('claim-chat-assistant-styles')) {
		return;
	}

	const style = document.createElement('style');

	style.id = 'claim-chat-assistant-styles';
	style.textContent = STYLES;
	document.head.appendChild(style);
}

/**
 * Reuses the spritemap URL the page's own Clay icons already point at, so the
 * icons resolve the same way; falls back to the theme's images path.
 */
function spritemapURL() {
	const use = document.querySelector('svg.lexicon-icon use');
	const href = use && (use.getAttribute('href') || use.getAttribute('xlink:href'));

	if (href && href.includes('#')) {
		return href.split('#')[0];
	}

	const themeImages =
		window.Liferay && window.Liferay.ThemeDisplay && window.Liferay.ThemeDisplay.getPathThemeImages
			? window.Liferay.ThemeDisplay.getPathThemeImages()
			: '/o/classic-theme/images';

	return `${themeImages}/clay/icons.svg`;
}

function icon(symbol, className = '') {
	return `<svg class="lexicon-icon lexicon-icon-${symbol} ${className}" focusable="false" role="presentation"><use href="${spritemapURL()}#${symbol}"></use></svg>`;
}

/* ------------------------------------------------------------------ */
/* Form adapter: reads the form through Liferay's accessibility layer  */
/* ------------------------------------------------------------------ */

function visibleText(element) {
	const clone = element.cloneNode(true);

	clone.querySelectorAll('.d-none, .sr-only, svg, script').forEach((node) => node.remove());

	return clone.textContent.replace(/\s+/g, ' ').trim();
}

function textForIds(ids) {
	return (ids || '')
		.split(/\s+/)
		.filter(Boolean)
		.map((id) => document.getElementById(id))
		.filter(Boolean)
		.map(visibleText)
		.filter(Boolean)
		.join(' ');
}

function firstId(ids) {
	return (ids || '').split(/\s+/).filter(Boolean).slice(0, 1).join('');
}

function fireChange(element) {
	element.dispatchEvent(new Event('input', {bubbles: true}));
	element.dispatchEvent(new Event('change', {bubbles: true}));
}

class FormAdapter {
	constructor(root) {
		this.form = root.querySelector('form');
		this.fields = [...root.querySelectorAll(`[data-field-name^="${FIELD_PREFIX}"]`)]
			.map((wrapper) => this._describe(wrapper))
			.filter(Boolean);
	}

	get usable() {
		return Boolean(this.form) && this.fields.length > 0;
	}

	_describe(wrapper) {
		const name = wrapper.dataset.fieldName.slice(FIELD_PREFIX.length);
		const type = wrapper.dataset.fieldType || 'text';

		const control =
			type === 'file'
				? wrapper.querySelector('input[type="file"]')
				: wrapper.querySelector('[role="combobox"], textarea, select, input:not([type="hidden"])');

		if (!control) {
			return null;
		}

		const label =
			textForIds(firstId(control.getAttribute('aria-labelledby'))) ||
			(control.labels && control.labels[0] && visibleText(control.labels[0])) ||
			control.getAttribute('aria-label') ||
			name;

		const options = [...wrapper.querySelectorAll('[role="option"][data-option-value]')].map((option) => ({
			label: option.dataset.optionLabel || visibleText(option),
			value: option.dataset.optionValue,
		}));

		return {
			control,
			helpText: textForIds(control.getAttribute('aria-describedby')),
			label,
			name,
			options,
			required: control.required || control.getAttribute('aria-required') === 'true',
			type,
			wrapper,
		};
	}

	field(name) {
		return this.fields.find((field) => field.name === name);
	}

	/**
	 * Compact on purpose: every turn sends it to the LLM, and its size drives
	 * the response time. File fields are left out (the agent cannot handle
	 * files); formats are stated in the agent's prompt.
	 */
	schema() {
		return this.fields
			.filter((field) => field.type !== 'file')
			.map((field) => {
				const entry = {label: field.label, name: field.name, type: field.type};

				if (field.required) {
					entry.required = true;
				}

				if (field.helpText) {
					entry.helpText = field.helpText;
				}

				if (field.options.length) {
					entry.options = field.options.map((option) =>
						option.label === option.value ? option.value : `${option.value}=${option.label}`
					);
				}

				return entry;
			});
	}

	getValue(field) {
		switch (field.type) {
			case 'boolean':
				return field.control.checked;
			case 'file':
				return field.control.files && field.control.files.length ? field.control.files[0].name : '';
			case 'select': {
				const hidden = field.wrapper.querySelector(`input[type="hidden"][name="${FIELD_PREFIX}${field.name}"]`);

				return hidden ? hidden.value : field.control.value;
			}
			default:
				return field.control.value;
		}
	}

	isFilled(field) {
		const value = this.getValue(field);

		return field.type === 'boolean' ? true : value !== '' && value !== null && value !== undefined;
	}

	state() {
		const state = {};

		this.fields.forEach((field) => {
			const value = this.getValue(field);

			if (field.type === 'boolean' ? value : value !== '') {
				state[field.name] = value;
			}
		});

		return state;
	}

	missingRequired() {
		return this.fields.filter((field) => field.required && !this.isFilled(field)).map((field) => field.name);
	}

	/** Returns the display value that was applied, or null when the value was rejected. */
	setValue(name, rawValue) {
		const field = this.field(name);

		if (!field || field.type === 'file' || rawValue === null || rawValue === undefined) {
			return null;
		}

		switch (field.type) {
			case 'select':
				return this._setSelect(field, rawValue);
			case 'boolean': {
				const value = rawValue === true || /^(true|yes|oui|1)$/i.test(String(rawValue));

				field.control.checked = value;
				fireChange(field.control);

				return value ? 'Yes' : 'No';
			}
			case 'number': {
				const value = parseFloat(String(rawValue).replace(/[^\d,.-]/g, '').replace(',', '.'));

				if (Number.isNaN(value)) {
					return null;
				}

				field.control.value = String(value);
				fireChange(field.control);

				return field.control.value;
			}
			case 'date-time': {
				const match = String(rawValue).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);

				if (!match) {
					return null;
				}

				field.control.value = `${match[1]}T${match[2] || '12:00'}`;
				fireChange(field.control);

				return field.control.value.replace('T', ' ');
			}
			case 'date': {
				const match = String(rawValue).match(/^\d{4}-\d{2}-\d{2}/);

				if (!match) {
					return null;
				}

				field.control.value = match[0];
				fireChange(field.control);

				return match[0];
			}
			default:
				field.control.value = String(rawValue);
				fireChange(field.control);

				return field.control.value;
		}
	}

	_setSelect(field, rawValue) {
		const wanted = String(rawValue).trim().toLowerCase();
		const option =
			field.options.find((candidate) => candidate.value.toLowerCase() === wanted) ||
			field.options.find((candidate) => candidate.label.toLowerCase() === wanted);

		if (!option) {
			return null;
		}

		const valueInput = field.wrapper.querySelector(`input[type="hidden"][name="${FIELD_PREFIX}${field.name}"]`);
		const labelInput = field.wrapper.querySelector(`input[type="hidden"][name="${FIELD_PREFIX}${field.name}-label"]`);

		if (valueInput) {
			valueInput.value = option.value;
			fireChange(valueInput);
		}

		if (labelInput) {
			labelInput.value = option.label;
		}

		field.control.value = option.label;
		field.control.dispatchEvent(new Event('change', {bubbles: true}));

		return option.label;
	}

	/** File fields whose accept list allows this file, filled or not. */
	fileSlots(file) {
		const extension = `.${(file.name.split('.').pop() || '').toLowerCase()}`;

		return this.fields.filter((field) => {
			if (field.type !== 'file') {
				return false;
			}

			const accept = (field.control.getAttribute('accept') || '').toLowerCase();

			return !accept || accept.split(',').map((item) => item.trim()).includes(extension);
		});
	}

	/** Puts a File into the given file field, replacing any previous file. */
	attachFileTo(field, file) {
		const transfer = new DataTransfer();

		transfer.items.add(file);
		field.control.files = transfer.files;
		field.control.dispatchEvent(new Event('change', {bubbles: true}));
	}
}

/* ------------------------------------------------------------------ */
/* AI Hub client                                                       */
/* ------------------------------------------------------------------ */

class AIHubClient {
	constructor({aiHubURL, chatbotExternalReferenceCode}) {
		this.aiHubURL = aiHubURL.replace(/\/$/, '');
		this.chatbotExternalReferenceCode = chatbotExternalReferenceCode;
		this.pending = null;
	}

	/**
	 * Cell on-behalf-of auth: AI Hub's own embed calls this before every send;
	 * without it, retrieval may silently return nothing.
	 */
	async _authHeaders() {
		if (AIHubClient.cellAvailable === false) {
			return {};
		}

		try {
			const response = await fetch(CELL_TOKEN_PATH, {
				headers: window.Liferay && window.Liferay.authToken ? {'x-csrf-token': window.Liferay.authToken} : {},
				method: 'POST',
			});

			if (response.status === 404) {
				AIHubClient.cellAvailable = false;

				return {};
			}

			if (!response.ok) {
				return {};
			}

			const {accessToken, userToken} = await response.json();

			return accessToken && userToken
				? {'Authorization': `Bearer ${accessToken}`, 'Liferay-AI-Hub-Cell-On-Behalf-Of': userToken}
				: {};
		}
		catch {
			return {};
		}
	}

	connect() {
		if (this.connection) {
			return this.connection;
		}

		this.connection = new Promise((resolve, reject) => {
			const source = new EventSource(`${this.aiHubURL}${AI_HUB_API}/chats/subscribe`, {withCredentials: true});
			let subscribed = false;

			this.source = source;

			source.addEventListener('Subscribe', (event) => {
				subscribed = true;
				resolve(AIHubClient._unwrap(event.data));
			});

			// Only these events end a turn; per-node progress events are ignored.
			source.addEventListener('Chat Message Sent', (event) => {
				this._settle(null, AIHubClient._unwrap(event.data));
			});

			source.addEventListener('Agent Invocation Failed', (event) => {
				this._settle(new Error(AIHubClient._unwrap(event.data) || 'Agent invocation failed'));
			});

			source.addEventListener('error', () => {
				if (!subscribed) {
					source.close();
					this.connection = null;
					reject(new Error('Unable to reach AI Hub'));
				}
			});
		});

		return this.connection;
	}

	static _unwrap(data) {
		try {
			const parsed = JSON.parse(data);

			return typeof parsed === 'object' && parsed !== null && 'data' in parsed ? parsed.data : parsed;
		}
		catch {
			return data;
		}
	}

	_settle(error, value) {
		if (!this.pending) {
			return;
		}

		const {reject, resolve, timer} = this.pending;

		clearTimeout(timer);
		this.pending = null;

		if (error) {
			reject(error);
		}
		else {
			resolve(value);
		}
	}

	async send(text, context) {
		const eventSourceReference = await this.connect();
		const headers = {'Content-Type': 'application/json', ...(await this._authHeaders())};

		const reply = new Promise((resolve, reject) => {
			this.pending = {
				reject,
				resolve,
				timer: setTimeout(() => this._settle(new Error('The assistant took too long to answer')), REPLY_TIMEOUT_MS),
			};
		});

		const response = await fetch(
			`${this.aiHubURL}${AI_HUB_API}/chats/by-external-reference-code/${encodeURIComponent(eventSourceReference)}/messages`,
			{
				body: JSON.stringify({
					chatbotExternalReferenceCode: this.chatbotExternalReferenceCode,
					context,
					instructionDefinitionScope: 'clickToChat',
					text,
				}),
				credentials: 'include',
				headers,
				method: 'POST',
			}
		);

		if (!response.ok) {
			this._settle(new Error(`AI Hub returned ${response.status}`));
		}

		return reply;
	}

	close() {
		if (this.source) {
			this.source.close();
		}
	}
}

/* ------------------------------------------------------------------ */
/* Agent reply parsing                                                 */
/* ------------------------------------------------------------------ */

function parseAgentReply(raw) {
	const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');

	if (start !== -1 && end > start) {
		try {
			const reply = JSON.parse(text.slice(start, end + 1));
			let fieldUpdates = reply.fieldUpdates || {};

			if (Array.isArray(fieldUpdates)) {
				fieldUpdates = Object.fromEntries(fieldUpdates.map((update) => [update.field || update.name, update.value]));
			}

			return {
				complete: reply.complete === true,
				fieldUpdates,
				message: reply.message || '',
				questions: Array.isArray(reply.questions) ? reply.questions : [],
				suggestions: Array.isArray(reply.suggestions) ? reply.suggestions : [],
			};
		}
		catch {
			// Not JSON: fall through and show the raw text.
		}
	}

	return {complete: false, fieldUpdates: {}, message: text, questions: [], suggestions: []};
}

/* ------------------------------------------------------------------ */
/* Custom element                                                      */
/* ------------------------------------------------------------------ */

let instanceCount = 0;

class ClaimChatAssistant extends HTMLElement {
	connectedCallback() {
		if (this.rendered) {
			return;
		}

		const wrapper = this.closest('[data-claim-chat-wrapper]');

		this.zone = wrapper && wrapper.querySelector('[data-claim-chat-form-zone]');
		this.adapter = this.zone && new FormAdapter(this.zone);

		const chatbotERC = (this.getAttribute('chatbot-external-reference-code') || '').trim();

		// No form (e.g. the success message after submission) or no chatbot:
		// leave the native form untouched.
		if (!this.adapter || !this.adapter.usable || !chatbotERC) {
			if (!chatbotERC) {
				console.warn('[claim-chat-assistant] No chatbot external reference code configured.');
			}

			return;
		}

		this.client = new AIHubClient({
			aiHubURL: this.getAttribute('ai-hub-url') || DEFAULT_AI_HUB_URL,
			chatbotExternalReferenceCode: chatbotERC,
		});

		injectStyles();
		this.rendered = true;
		this._render();
		this._showChat();
		this._bubble('assistant', this.getAttribute('welcome-message') || DEFAULT_WELCOME);
		this._updateProgress();
		this.client.connect().catch(() => this._unavailable());
	}

	disconnectedCallback() {
		if (this.client) {
			this.client.close();
		}
	}

	_render() {
		const inputId = `claim-chat-input-${++instanceCount}`;
		const fileFields = this.adapter.fields.filter((field) => field.type === 'file');
		const accept = [
			...new Set(
				fileFields.flatMap((field) => (field.control.getAttribute('accept') || '').split(',')).map((item) => item.trim())
			),
		]
			.filter(Boolean)
			.join(',');

		this.innerHTML = `
			<section class="card" data-chat aria-label="Claim declaration assistant">
				<div class="card-header d-flex align-items-center justify-content-between flex-wrap">
					<div class="d-flex align-items-center">
						<span class="sticker sticker-primary sticker-rounded mr-3">${icon('chatbot')}</span>
						<div>
							<div class="h4 mb-1">Claim assistant</div>
							<div class="claim-chat-progress progress-group">
								<div class="progress">
									<div class="progress-bar" role="progressbar" data-progress-bar aria-valuemin="0" style="width: 0%"></div>
								</div>
								<div class="progress-group-addon small" data-progress-label aria-live="polite"></div>
							</div>
						</div>
					</div>
					<button class="btn btn-secondary btn-sm" type="button" data-show-form>
						<span class="inline-item inline-item-before">${icon('forms')}</span>Fill in the form myself
					</button>
				</div>
				<div class="card-body claim-chat-log d-flex flex-column" data-log role="log" aria-live="polite"></div>
				<div class="d-flex flex-wrap px-3" data-suggestions></div>
				<div class="card-footer">
					<form data-composer>
						<div class="input-group">
							${
								fileFields.length
									? `<div class="input-group-item input-group-item-shrink">
										<button class="btn btn-monospaced btn-secondary" type="button" data-attach aria-label="Attach photos or documents" title="Attach photos or documents">${icon('paperclip')}</button>
										<input type="file" multiple hidden data-file-input accept="${accept}">
									</div>`
									: ''
							}
							<div class="input-group-item">
								<label class="sr-only" for="${inputId}">Your message</label>
								<textarea class="form-control claim-chat-input" id="${inputId}" data-input rows="1" placeholder="Type your answer…"></textarea>
							</div>
							<div class="input-group-item input-group-item-shrink">
								<button class="btn btn-monospaced btn-primary" type="submit" data-send aria-label="Send" title="Send">${icon('send')}</button>
							</div>
						</div>
					</form>
				</div>
			</section>
			<div class="alert alert-info d-none" data-back role="status" hidden>
				<div class="align-items-center d-flex flex-wrap justify-content-between">
					<span class="mr-3">Review the information below, complete it if needed, then submit your claim.</span>
					<button class="btn btn-secondary btn-sm" type="button" data-show-chat>
						<span class="inline-item inline-item-before">${icon('chatbot')}</span>Back to the assistant
					</button>
				</div>
			</div>
		`;

		this.$ = (selector) => this.querySelector(selector);

		this.$('[data-composer]').addEventListener('submit', (event) => {
			event.preventDefault();
			this._submitInput();
		});

		this.$('[data-input]').addEventListener('input', () => this._autoGrow());

		this.$('[data-input]').addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				this._submitInput();
			}
		});

		this.$('[data-show-form]').addEventListener('click', () => this._showForm());
		this.$('[data-show-chat]').addEventListener('click', () => this._showChat());

		if (fileFields.length) {
			const fileInput = this.$('[data-file-input]');

			this.$('[data-attach]').addEventListener('click', () => fileInput.click());
			fileInput.addEventListener('change', () => {
				this._attach([...fileInput.files]);
				fileInput.value = '';
			});
		}
	}

	/**
	 * Clay display utilities (d-flex, d-block...) are !important and beat the
	 * hidden attribute, so visibility also toggles Clay's own d-none.
	 */
	_setVisible(element, visible) {
		element.hidden = !visible;
		element.classList.toggle('d-none', !visible);
	}

	/**
	 * Grows the text box with its content up to the CSS max-height, then
	 * scrolls. Clay's form-control has a fixed height, hence the inline one.
	 */
	_autoGrow() {
		const input = this.$('[data-input]');
		const maxHeight = parseFloat(getComputedStyle(input).maxHeight) || Infinity;

		input.style.height = 'auto';

		const height = Math.min(input.scrollHeight + input.offsetHeight - input.clientHeight, maxHeight);

		input.style.height = `${height}px`;
		input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
	}

	_showChat() {
		this._setVisible(this.zone, false);
		this._setVisible(this.$('[data-chat]'), true);
		this._setVisible(this.$('[data-back]'), false);
		this.$('[data-input]').focus();
	}

	_showForm() {
		this._setVisible(this.zone, true);
		this._setVisible(this.$('[data-chat]'), false);
		this._setVisible(this.$('[data-back]'), true);
		this.scrollIntoView({behavior: 'smooth', block: 'start'});
	}

	_append(element) {
		const log = this.$('[data-log]');

		log.appendChild(element);
		log.scrollTop = log.scrollHeight;

		return element;
	}

	_bubble(kind, text) {
		const element = document.createElement('div');

		if (kind === 'note') {
			element.className = 'align-self-center mb-3 small text-secondary text-center';
		}
		else if (kind === 'user') {
			element.className = 'claim-chat-bubble align-self-end bg-primary mb-3 px-3 py-2 rounded text-white';
		}
		else {
			element.className = 'claim-chat-bubble align-self-start bg-light mb-3 px-3 py-2 rounded';
		}

		element.textContent = text;

		return this._append(element);
	}

	_updatesSummary(applied) {
		if (!applied.length) {
			return;
		}

		const container = document.createElement('div');

		container.className = 'align-self-start d-flex flex-wrap mb-3';
		container.setAttribute('aria-label', 'Fields filled in');
		applied.forEach(({label, value}) => {
			const chip = document.createElement('span');
			const text = document.createElement('span');

			chip.className = 'claim-chat-update label label-success mb-1 mr-1';
			chip.title = `${label}: ${value}`;
			chip.innerHTML = `<span class="label-item label-item-before">${icon('check')}</span>`;
			text.className = 'label-item label-item-expand';
			text.textContent = `${label}: ${String(value).length > 60 ? `${String(value).slice(0, 57)}…` : value}`;
			chip.appendChild(text);
			container.appendChild(chip);
		});

		this._append(container);
	}

	/**
	 * Quick replies do not send anything: each click toggles a selection, and
	 * the selections go out with the typed text when the customer sends.
	 */
	_setSuggestions(suggestions) {
		const container = this.$('[data-suggestions]');

		this.selected = [];
		container.textContent = '';
		suggestions.slice(0, 8).forEach((suggestion) => {
			const button = document.createElement('button');

			button.className = 'btn btn-outline-primary btn-sm mb-2 mr-2';
			button.type = 'button';
			button.textContent = suggestion;
			button.setAttribute('aria-pressed', 'false');
			button.addEventListener('click', () => {
				const pressed = !this.selected.includes(suggestion);

				this.selected = pressed
					? [...this.selected, suggestion]
					: this.selected.filter((item) => item !== suggestion);
				button.setAttribute('aria-pressed', String(pressed));
				button.classList.toggle('btn-primary', pressed);
				button.classList.toggle('btn-outline-primary', !pressed);
				this.$('[data-input]').focus();
			});
			container.appendChild(button);
		});
	}

	_updateProgress() {
		const required = this.adapter.fields.filter((field) => field.required);
		const filled = required.filter((field) => this.adapter.isFilled(field)).length;
		const bar = this.$('[data-progress-bar]');

		bar.style.width = `${required.length ? Math.round((filled / required.length) * 100) : 100}%`;
		bar.setAttribute('aria-valuemax', String(required.length));
		bar.setAttribute('aria-valuenow', String(filled));
		this.$('[data-progress-label]').textContent = `${filled} of ${required.length} required`;
	}

	_setBusy(busy) {
		this.busy = busy;
		this.$('[data-send]').disabled = busy;

		if (busy) {
			const typing = document.createElement('div');

			typing.className = 'align-self-start mb-3 px-3 py-2';
			typing.innerHTML =
				'<span aria-hidden="true" class="loading-animation loading-animation-sm"></span><span class="sr-only">The assistant is typing</span>';
			this.typing = this._append(typing);
		}
		else if (this.typing) {
			this.typing.remove();
			this.typing = null;
			this.$('[data-input]').focus();
		}
	}

	_context() {
		const now = new Date();
		const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

		return {
			currentDateTime: local,
			formSchema: JSON.stringify(this.adapter.schema()),
			formState: JSON.stringify(this.adapter.state()),
			locale: document.documentElement.lang || navigator.language,
			missingRequiredFields: JSON.stringify(this.adapter.missingRequired()),
		};
	}

	_submitInput() {
		const input = this.$('[data-input]');
		const typed = input.value.trim();
		const selected = this.selected || [];

		if (this.busy || (!typed && !selected.length)) {
			return;
		}

		const parts = [];

		if (selected.length) {
			parts.push(selected.join(', '));
		}

		if (typed) {
			parts.push(typed);
		}

		input.value = '';
		this._autoGrow();
		this._send(parts.join('. '));
	}

	async _send(text) {
		this._setSuggestions([]);
		this._bubble('user', text);
		this._setBusy(true);

		const context = this._context();
		let messageText = text;

		if (this.getAttribute('embed-context-in-message') === 'true') {
			messageText = `${text}\n\n[FORM CONTEXT]\n${Object.entries(context)
				.map(([key, value]) => `${key}: ${value}`)
				.join('\n')}`;
		}

		try {
			const raw = await this.client.send(messageText, context);

			this._setBusy(false);
			this._handleReply(parseAgentReply(raw));
		}
		catch (error) {
			this._setBusy(false);
			console.error('[claim-chat-assistant]', error);
			this._bubble('assistant', "Sorry, I couldn't process that. You can try again, or fill in the form yourself.");
		}
	}

	_handleReply(reply) {
		const applied = [];
		const rejected = [];

		Object.entries(reply.fieldUpdates).forEach(([name, value]) => {
			const display = this.adapter.setValue(name, value);
			const field = this.adapter.field(name);

			if (display === null) {
				if (field) {
					rejected.push(field.label);
				}
			}
			else {
				applied.push({label: field.label, value: display});
			}
		});

		if (reply.message) {
			this._bubble('assistant', reply.message);
		}

		this._updatesSummary(applied);
		reply.questions.forEach((question) => this._bubble('assistant', question));

		if (rejected.length) {
			console.warn('[claim-chat-assistant] Rejected values for:', rejected);
		}

		this._setSuggestions(reply.suggestions);
		this._updateProgress();

		const missing = this.adapter.missingRequired();

		if (reply.complete && !missing.length) {
			this._bubble('note', 'All the information is collected. Please review the form and submit it.');
			setTimeout(() => this._showForm(), 1200);
		}
		else if (reply.complete) {
			const labels = missing.map((name) => this.adapter.field(name).label).join(', ');

			this._bubble('note', `A few required details are still missing: ${labels}.`);
		}
	}

	/**
	 * The user decides which file field each file fills. Nothing is sent to
	 * the agent, which cannot analyze files: the next message's formState
	 * lists the attached file names.
	 */
	_attach(files) {
		const done = () => this._updateProgress();

		files.forEach((file) => {
			const slots = this.adapter.fileSlots(file);

			if (!slots.length) {
				this._bubble('note', `${file.name} cannot be attached: this file type is not accepted.`);
				done();

				return;
			}

			this._fileChoice(file, slots, done);
		});
	}

	_fileChoice(file, slots, onChoice) {
		const card = document.createElement('div');
		const body = document.createElement('div');
		const preview = document.createElement('div');
		const text = document.createElement('div');
		const name = document.createElement('div');
		const prompt = document.createElement('div');
		const actions = document.createElement('div');

		card.className = 'align-self-end card claim-chat-file mb-3';
		body.className = 'card-body d-flex p-3';
		preview.className = 'mr-3';
		name.className = 'font-weight-semi-bold text-truncate';
		name.textContent = file.name;
		name.title = file.name;
		prompt.className = 'mb-2 small text-secondary';
		prompt.textContent = 'What does this file show?';
		actions.className = 'd-flex flex-wrap';

		if (file.type.startsWith('image/')) {
			const image = document.createElement('img');

			image.alt = '';
			image.className = 'claim-chat-thumbnail rounded';
			image.src = URL.createObjectURL(file);
			image.addEventListener('load', () => URL.revokeObjectURL(image.src));
			preview.appendChild(image);
		}
		else {
			preview.innerHTML = `<span class="sticker sticker-light sticker-lg">${icon('document')}</span>`;
		}

		const finish = (field) => {
			actions.remove();
			prompt.className = 'small';

			if (field) {
				prompt.innerHTML = `<span class="claim-chat-update label label-success"><span class="label-item label-item-before">${icon('check')}</span><span class="label-item label-item-expand"></span></span>`;
				prompt.querySelector('.label-item-expand').textContent = field.label;
			}
			else {
				prompt.className = 'small text-secondary';
				prompt.textContent = 'Not attached';
			}

			onChoice(field);
		};

		slots.forEach((field) => {
			const button = document.createElement('button');
			const filled = this.adapter.isFilled(field);

			button.className = 'btn btn-outline-primary btn-sm mb-1 mr-1';
			button.type = 'button';
			button.textContent = filled ? `${field.label} (replace)` : field.label;
			button.addEventListener('click', () => {
				this.adapter.attachFileTo(field, file);
				finish(field);
			});
			actions.appendChild(button);
		});

		const cancel = document.createElement('button');

		cancel.className = 'btn btn-link btn-sm mb-1';
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => finish(null));
		actions.appendChild(cancel);

		text.className = 'claim-chat-file-text';
		text.append(name, prompt, actions);
		body.append(preview, text);
		card.appendChild(body);
		this._append(card);
		actions.querySelector('button').focus();
	}

	_unavailable() {
		this._bubble('assistant', 'The assistant is unavailable right now. You can fill in the form directly.');
		this.$('[data-send]').disabled = true;
		this.$('[data-input]').disabled = true;
	}
}

if (!customElements.get('claim-chat-assistant')) {
	customElements.define('claim-chat-assistant', ClaimChatAssistant);
}

export default ClaimChatAssistant;
