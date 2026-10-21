# MarkNet Faktury — moduł do przeglądu przed wdrożeniem

Integracja z generator-ofert na gałęzi feature/marknet-faktury-ksef.

## Przepływ

1. Zapisz ofertę ze statusem Zaakceptowana. Dodaj NIP i adres klienta.
2. Kliknij Przekształć w fakturę w generatorze lub Fakturuj w panelu /faktury.
3. Sprawdź dane nabywcy, pozycje i rabat. Konwersja zachowuje dane oferty (ilość, dni, cena). Stawka VAT to 23%.
4. Zapisz szkic i zatwierdź numer w osobnej serii MM/FV/YYYY/MM/NNNN.
5. Po przejściu testów możliwa wysyłka do KSeF, kontrola statusu, pobranie UPO i wygenerowanie PDF z kodem QR. SMTP wysyła PDF dopiero po potwierdzeniu KSeF.
6. Faktury ręczne: w panelu Nowa faktura. Dostępne oznaczanie płatności i eksport kompletnej kopii JSON.

## Ważne ograniczenia

- TO WERSJA TESTOWA, NIE GOTOWA DO PRODUKCYJNEGO FAKTUROWANIA KSeF. Nie zatwierdzono jeszcze zgodności wygenerowanego FA(3) z oficjalnym XSD i nie testowano tokenów, sesji ani statusów na API.
- Wysyłka produkcyjna jest celowo zablokowana bez KSEF_ENV=prod i KSEF_LIVE_ENABLED=true. Nie włączaj tych wartości bez audytu i testów.
- Nie obsługuje faktur korygujących, zaliczkowych, nietypowych stawek VAT, transakcji zagranicznych, białej listy, JPK ani synchronizacji z księgowością.
- Status Wystawiona oznacza zatwierdzenie numeru w aplikacji, nie potwierdzenie nadania numeru w KSeF.
- Po niejasnym błędzie sieciowym system zapisuje status unknown i celowo nie ponawia wysyłki automatycznie, aby uniknąć dubli. Trzeba ręcznie sprawdzić KSeF.
- Katalog STORAGE_DIR/billing musi znajdować się na prywatnym trwałym dysku (Render), z regularnymi szyfrowanymi kopiami zapasowymi.
- Dane klientów i tokeny nie mogą trafić do publicznego GitHub. Token KSeF i hasło SMTP dodawaj WYŁĄCZNIE jako sekrety serwera.
- Wymagane dalsze prace nad uwierzytelnianiem, sesjami, CSRF, audytem logów, bazą transakcyjną i ochroną przed równoległym nadawaniem numerów. Do tego czasu jedna instancja aplikacji i ostrożne testy.
- Moduł faktur jest dostępny tylko administratorom. API szkiców ofert zostało zabezpieczone logowaniem — sprawdź automatyzacje, jeśli używały go bez sesji.

## Ustawienia środowiska serwera

BILLING_ENABLED=true — aktywuje panel w środowisku bez domyślnego hasła
ADMIN_PASS — silne indywidualne hasło, nie domyślne
BILLING_SELLER_NAME — nazwa sprzedawcy
BILLING_SELLER_NIP — NIP
BILLING_SELLER_ADDRESS — pełny adres
BILLING_BANK_ACCOUNT — rachunek bankowy
STORAGE_DIR=/var/data — trwały dysk
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM — nadawca e-mail
KSEF_TOKEN — sekretny token z uprawnieniami
KSEF_ENV=prod i KSEF_LIVE_ENABLED=true — wyłącznie po audycie i testach
BILLING_FONT, BILLING_FONT_BOLD — opcjonalne ścieżki do fontów obsługujących polskie znaki

## Testy

npm install
npm test

Workflow CI uruchamia node --check i testy konwersji.

## Stan prac

Gotowe w kodzie: UI /faktury, przejęcie zaakceptowanych ofert, zapisywanie faktur, PDF, ręczne szkice, e-mail SMTP, przygotowana ścieżka KSeF i UPO, śledzenie płatności, eksport backupu.

Nieprzeprowadzone: wdrożenie do Render, wysyłka rzeczywistych faktur, testy rzeczywistego SMTP/KSeF, walidacja XSD, przegląd prawny i bezpieczeństwa. Nie rezygnuj z dotychczasowej możliwości prawidłowego fakturowania, zanim te testy się zakończą.

Dokumentacja MF: https://api.ksef.mf.gov.pl/
