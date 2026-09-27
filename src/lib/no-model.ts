import { t } from "../../shared/i18n";

/**
 * pi's own words when there is nothing to send to:
 * "prompt: No API key found for the selected model. Use /login … See
 * /home/user/…/node_modules/@earendil-works/…/docs/providers.md". That path is the SDK's install
 * directory, so for the user it is a wall of text; the UI shows one line and a button instead.
 */
export function isNoModelFailure(error: string): boolean {
  return /no api key found|use \/login\b|no model selected|set the model with \/model/i.test(error);
}

/** The line under the composer (and the chat note) when there is no model to send to. */
export function noModelHint(): string {
  return t("Nie ma modelu — wiadomość nie ma dokąd iść.");
}

/** One action, the same one the composer chip offers. */
export function noModelAction(): string {
  return t("dodaj dostawcę modeli");
}

/** What the model has to be told about: a missing key, not a missing program. */
export function noModelInfo(): string {
  return t("Model nie ma klucza API — dodaj dostawcę w Ustawieniach, potem wybierz model z listy.");
}
