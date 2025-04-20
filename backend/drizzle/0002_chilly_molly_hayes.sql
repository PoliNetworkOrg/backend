CREATE TABLE "tg_messages" (
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"timestamp" timestamp NOT NULL,
	"message" varchar(8704) NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "tg_messages_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
