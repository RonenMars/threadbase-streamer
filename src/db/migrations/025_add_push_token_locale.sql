-- The language the registering app displays, so a notification reaches the
-- phone in that language rather than always in English.
--
-- A BCP 47 tag as the client sent it ("he", "en-US"). NULL for a client that
-- predates this column and sent no Accept-Language either; the send path
-- treats NULL as English.
ALTER TABLE push_tokens ADD COLUMN locale TEXT;
