if (!document.body.classList.contains('has-edit-mode-menu')) {
	import('claim-chat-assistant').catch((error) => {
		console.error('Unable to load the claim chat assistant', error);

		const zone = fragmentElement.querySelector('[data-claim-chat-form-zone]');

		if (zone) {
			zone.hidden = false;
		}
	});
}
