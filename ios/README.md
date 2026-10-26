# Mark Media na iPhone i iPad

Projekt aplikacji iOS 17+ dla istniejącego systemu https://generator-ofert.onrender.com.
Konto Apple Developer, uprawnienia do App Store Connect i podpisanie należą do właściciela aplikacji. Nie zapisuj certyfikatów ani kluczy w GitHubie.

## Co zawiera projekt

- Natywne logowanie z sesją przechowywaną w Keychain. Hasło nie jest zapisywane.
- Natywną listę wydarzeń, wyszukiwanie, odświeżanie i dostęp do przypisanych packlist.
- Natywny kalendarz dostępności, niedostępności i usuwania deklaracji.
- Moduły ofert, magazynu, packlist, historii logowań oraz podglądu zespołu w kontrolowanym WKWebView, połączone z istniejącym serwerem i rolami.
- Obsługę systemowego druku, pobierania plików, udostępniania pobranych plików i okien potwierdzeń.
- Dostęp internetowy jest wymagany. Nie ma powiadomień push ani edycji offline.

## Otwórz na Macu

1. Zainstaluj stabilny Xcode 26 lub nowszy i uruchom go, aby dokończyć instalację komponentów iOS.
2. Pobierz repozytorium i przejdź w Terminalu do katalogu `ios`.
3. Zainstaluj XcodeGen: `brew install xcodegen`.
4. Wygeneruj projekt: `xcodegen generate`.
5. Otwórz `MarkMedia.xcodeproj` w Xcode.
6. W Xcode → Settings → Accounts zaloguj się do swojego Apple Account.
7. W projekcie MarkMedia → Signing & Capabilities wybierz swój Team. Proponowany Bundle ID to `pl.markmedia.generatorofert`; sprawdź jego dostępność. Jeśli zmieniasz Bundle ID, zapisz go też w `project.yml` przed kolejnym generowaniem projektu.
8. Uruchom aplikację na podłączonym iPhonie i na symulatorze iPada.

Nie dodano identyfikatora Team ani podpisów, ponieważ nie zostały udostępnione. Projekt wymaga kompilacji w Xcode; sam kod źródłowy nie jest plikiem do zainstalowania na iPhonie.

## Sprawdzenie przed TestFlight

- Zaloguj konto pracownika oraz administratora. Nie używaj kont rzeczywistych pracowników w publicznych zrzutach ekranu.
- Sprawdź, że pracownik widzi tylko własne wydarzenia i nie otwiera cudzego wydarzenia.
- Zapisz dyspozycyjność i sprawdź ją z panelu administratora.
- Przetestuj edycję i potwierdzenia packlist, obliczenia LED oraz zapis po ponownym uruchomieniu.
- Sprawdź wydruk PDF oferty i jego link do wrzutki, eksport Excela, wybór plików i udostępnianie pobranych plików.
- Przetestuj brak Internetu, ponowne logowanie po restarcie serwera i wylogowanie z obu rodzajów ekranów.
- Sprawdź VoiceOver, większy tekst, iPhone i iPad.

## Wyślij do TestFlight

1. W App Store Connect utwórz aplikację iOS „Mark Media” z Bundle ID identycznym jak w Xcode.
2. W Xcode wybierz „Any iOS Device”, potem Product → Archive.
3. W Organizer wybierz Distribute App → App Store Connect → Upload.
4. Po przetworzeniu wersji w App Store Connect otwórz TestFlight, uzupełnij informacje testowe i dodaj testerów.
5. Testy zewnętrzne mogą wymagać Beta App Review. Publikacja w App Store wymaga osobnego zgłoszenia i oceny Apple.

Wersje muszą mieć rosnący `CURRENT_PROJECT_VERSION`. CI buduje wersję symulatorową bez podpisu; nie wysyła nic do Apple.

## Informacje do App Store Connect

Nazwa robocza: Mark Media. Kategoria proponowana: Business. Adres polityki prywatności: https://generator-ofert.onrender.com/polityka-prywatnosci.
Uzupełnij docelowy adres wsparcia, prawa do marki, dane właściciela, opis i zrzuty z prawdziwego urządzenia. Zweryfikuj, że polityka prywatności obejmuje aplikację mobilną, historię logowań oraz dyspozycyjność pracowników; obecna strona była przygotowana dla serwisu i wrzutki.
W formularzu App Privacy opisz faktyczne dane przetwarzane przez system, w tym identyfikatory kont, harmonogramy i dane klientów w modułach webowych. Nie zaznaczaj „Data Not Collected”.
Przygotuj ograniczone konto demonstracyjne z fikcyjnymi wydarzeniami dla recenzenta. Konta w systemie zakłada administrator; aplikacja nie ma publicznego zakładania kont.
Przy zgłoszeniu wskaż natywne funkcje: logowanie, lista i wyszukiwanie wydarzeń, kalendarz dyspozycyjności, druk i udostępnianie plików. Akceptację ocenia Apple; projekt nie ma gwarancji zatwierdzenia.

Dokumentacja:
- https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/
- https://developer.apple.com/app-store/review/guidelines/
- https://github.com/yonaskolb/XcodeGen
