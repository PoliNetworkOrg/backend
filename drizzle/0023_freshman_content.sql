CREATE TABLE "web_freshman_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"href" text NOT NULL,
	"created_by_id" bigint,
	"modified_by_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_freshman_cards_creator_check" CHECK ("web_freshman_cards"."created_by_id" IS NOT NULL OR "web_freshman_cards"."created_by_sub" IS NOT NULL),
	CONSTRAINT "web_freshman_cards_slot_check" CHECK ("web_freshman_cards"."id" in ('featured-1', 'featured-2', 'guides-1', 'guides-2', 'guides-3', 'guides-4', 'guides-5', 'materials-1', 'tools-1', 'tools-2', 'telegram-1', 'telegram-2', 'telegram-3', 'telegram-4', 'telegram-5', 'telegram-6', 'telegram-7', 'telegram-8')),
	CONSTRAINT "web_freshman_cards_icon_check" CHECK ("web_freshman_cards"."icon" in ('chart', 'monitor', 'book', 'map', 'news', 'money', 'folder', 'repeat', 'refresh', 'bell', 'user', 'users', 'cart', 'home'))
);
--> statement-breakpoint
CREATE TABLE "web_freshman_faqs" (
	"position" integer PRIMARY KEY NOT NULL,
	"faq_id" integer NOT NULL,
	"created_by_id" bigint,
	"modified_by_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_freshman_faqs_faq_id_unique" UNIQUE("faq_id"),
	CONSTRAINT "web_freshman_faqs_creator_check" CHECK ("web_freshman_faqs"."created_by_id" IS NOT NULL OR "web_freshman_faqs"."created_by_sub" IS NOT NULL),
	CONSTRAINT "web_freshman_faqs_position_check" CHECK ("web_freshman_faqs"."position" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "web_freshman_cards" ADD CONSTRAINT "web_freshman_cards_created_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_freshman_cards" ADD CONSTRAINT "web_freshman_cards_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" ADD CONSTRAINT "web_freshman_faqs_faq_id_web_faqs_id_fk" FOREIGN KEY ("faq_id") REFERENCES "public"."web_faqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" ADD CONSTRAINT "web_freshman_faqs_created_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" ADD CONSTRAINT "web_freshman_faqs_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO web_freshman_cards (id, title, description, icon, href, created_by_sub) VALUES
('featured-1', 'Graduatorie', 'Risultati storici e soglie di accesso per i vari corsi di laurea.', 'chart', 'https://rankings.polinetwork.org/', 'system:freshman-migration'),
('featured-2', 'Progetto TOL', 'Informazioni sul test di ingresso (TOL) e su come prepararsi al meglio.', 'monitor', 'https://tol.polinetwork.org/', 'system:freshman-migration'),
('guides-1', 'Guida della matricola', 'Dalla prima iscrizione alla vita in campus: il manuale completo per ogni nuovo studente.', 'book', '/matricole/guida', 'system:freshman-migration'),
('guides-2', 'Mappa Microonde', 'Dove scaldare il pranzo nei vari campus.', 'map', '', 'system:freshman-migration'),
('guides-3', 'Corsi a Scelta', 'Consigli su come comporre il Piano di Studi.', 'book', '', 'system:freshman-migration'),
('guides-4', 'News', 'Le ultime novità dagli studenti del Politecnico.', 'news', '', 'system:freshman-migration'),
('guides-5', 'Borsa di Studio', 'Requisiti e scadenze per le agevolazioni.', 'money', '', 'system:freshman-migration'),
('materials-1', 'Materiali', 'Il più grande archivio didattico creato dagli studenti per gli studenti del Politecnico di Milano. Migliaia di appunti e temi d’esame.', 'folder', '/materials', 'system:freshman-migration'),
('tools-1', 'Sync Orario', '', 'repeat', 'https://bebora.github.io/polimi-schedule-js/', 'system:freshman-migration'),
('tools-2', 'WeBeep Sync', '', 'refresh', 'https://github.com/toto04/webeep-sync', 'system:freshman-migration'),
('telegram-1', 'Generale', '', 'bell', 'https://t.me/PoliGruppo', 'system:freshman-migration'),
('telegram-2', 'Matricole', '', 'user', 'https://t.me/polimatricole', 'system:freshman-migration'),
('telegram-3', 'Ripetizioni', '', 'users', 'https://t.me/joinchat/l10OF3vF6fEzOTRk', 'system:freshman-migration'),
('telegram-4', 'PoliBook', '', 'book', 'https://t.me/joinchat/6nmuXXhAOr1mYTJk', 'system:freshman-migration'),
('telegram-5', 'DSU', '', 'money', 'https://t.me/joinchat/4kO9DtAiTVM0NTU0', 'system:freshman-migration'),
('telegram-6', 'Mercatino', '', 'cart', 'https://t.me/mercatinopolimi', 'system:freshman-migration'),
('telegram-7', 'Case', '', 'home', 'https://t.me/joinchat/jmpNOitFNFw1MzJk', 'system:freshman-migration'),
('telegram-8', 'Consigli PC', '', 'monitor', 'https://t.me/joinchat/oD7NGpl0W6VjYmI0', 'system:freshman-migration');
--> statement-breakpoint
DO $$
DECLARE category integer; selected integer;
BEGIN
  SELECT id INTO category FROM web_faq_categories WHERE title_it = 'Matricole' ORDER BY id LIMIT 1;
  IF category IS NULL THEN
    INSERT INTO web_faq_categories (title_it, title_en, icon, created_by_sub)
    VALUES ('Matricole', 'Freshmen', 'graduation-cap', 'system:freshman-migration') RETURNING id INTO category;
  END IF;
  SELECT id INTO selected FROM web_faqs WHERE title_it = 'Le lezioni della prima settimana si tengono regolarmente?' ORDER BY id LIMIT 1;
  IF selected IS NULL THEN
    INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub)
    VALUES ('Le lezioni della prima settimana si tengono regolarmente?', 'Are classes held during the first week?', 'Spesso, la prima settimana, i Professori utilizzano le ore destinate alle esercitazioni per qualche ora di lezione in più: saranno quindi i docenti a specificare come verranno utilizzate queste ore. Dunque, le esercitazioni non sono da considerarsi annullate, salvo diversa comunicazione da parte del docente o dell''esercitatore.', 'Teachers will explain how lecture and exercise sessions are organized during the first week. Unless your teacher announces otherwise, attend the scheduled sessions.', category, 'system:freshman-migration') RETURNING id INTO selected;
  END IF;
  INSERT INTO web_freshman_faqs (position, faq_id, created_by_sub) VALUES (0, selected, 'system:freshman-migration');
  SELECT id INTO selected FROM web_faqs WHERE title_it = 'Come faccio ad accedere ai materiali del corso?' ORDER BY id LIMIT 1;
  IF selected IS NULL THEN
    INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub)
    VALUES ('Come faccio ad accedere ai materiali del corso?', 'How do I access course materials?', 'I materiali dei corsi sono disponibili su Beep (il portale e-learning del Politecnico). Puoi accedervi con le tue credenziali di Ateneo (codice persona e password). Ogni docente carica le proprie slide, esercizi e risorse direttamente sulla pagina del corso.', 'Access the university e-learning platform with your university credentials. Teachers publish course slides, exercises and other materials on their course pages.', category, 'system:freshman-migration') RETURNING id INTO selected;
  END IF;
  INSERT INTO web_freshman_faqs (position, faq_id, created_by_sub) VALUES (1, selected, 'system:freshman-migration');
  SELECT id INTO selected FROM web_faqs WHERE title_it = 'Come funziona la prenotazione agli esami?' ORDER BY id LIMIT 1;
  IF selected IS NULL THEN
    INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub)
    VALUES ('Come funziona la prenotazione agli esami?', 'How do I register for exams?', 'La prenotazione agli esami avviene tramite il portale Online Services (servizionline.polimi.it). Devi prenotarti entro la scadenza indicata per ogni appello. Ricordati di verificare i prerequisiti necessari prima di iscriverti a un esame.', 'Register through the university Online Services before the deadline for each exam session, checking any prerequisites.', category, 'system:freshman-migration') RETURNING id INTO selected;
  END IF;
  INSERT INTO web_freshman_faqs (position, faq_id, created_by_sub) VALUES (2, selected, 'system:freshman-migration');
  SELECT id INTO selected FROM web_faqs WHERE title_it = 'Cos''è il codice persona e dove lo trovo?' ORDER BY id LIMIT 1;
  IF selected IS NULL THEN
    INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub)
    VALUES ('Cos''è il codice persona e dove lo trovo?', 'What is the codice persona and where can I find it?', 'Il codice persona è il tuo identificativo univoco al Politecnico, composto da 6 cifre. Lo trovi nella lettera di ammissione o nella mail di benvenuto ricevuta dopo l''immatricolazione. Serve per accedere a tutti i servizi online dell''Ateneo.', 'The codice persona is your university account identifier. Check your admission or enrollment documents and university account details.', category, 'system:freshman-migration') RETURNING id INTO selected;
  END IF;
  INSERT INTO web_freshman_faqs (position, faq_id, created_by_sub) VALUES (3, selected, 'system:freshman-migration');
  SELECT id INTO selected FROM web_faqs WHERE title_it = 'Come posso contattare PoliNetwork?' ORDER BY id LIMIT 1;
  IF selected IS NULL THEN
    INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub)
    VALUES ('Come posso contattare PoliNetwork?', 'How can I contact PoliNetwork?', 'Puoi contattare PoliNetwork tramite i nostri canali Telegram o attraverso il sito ufficiale. Siamo un''associazione studentesca e offriamo supporto, risorse e una community per tutti gli studenti del Politecnico.', 'Contact PoliNetwork through its Telegram channels or the contact links on the website.', category, 'system:freshman-migration') RETURNING id INTO selected;
  END IF;
  INSERT INTO web_freshman_faqs (position, faq_id, created_by_sub) VALUES (4, selected, 'system:freshman-migration');
END $$;
