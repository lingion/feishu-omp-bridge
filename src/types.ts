/**
 * Shape of the `im.message.receive_v1` event payload, as delivered by the
 * Feishu long-connection (WSClient) event dispatcher. Mirrors the structure
 * declared in @larksuiteoapi/node-sdk types (which are not exported by name).
 */
export type IncomingMessage = {
	event_id?: string;
	create_time?: string;
	event_type?: string;
	tenant_key?: string;
	app_id?: string;
	sender: {
		sender_id?: {
			union_id?: string;
			user_id?: string;
			open_id?: string;
		};
		sender_type: string;
		tenant_key?: string;
	};
	message: {
		message_id: string;
		root_id?: string;
		parent_id?: string;
		create_time: string;
		chat_id: string;
		chat_type: string;
		message_type: string;
		content: string;
		mentions?: Array<{
			key: string;
			name: string;
			id: { union_id?: string; user_id?: string; open_id?: string };
			mentioned_type?: string;
		}>;
	};
};
