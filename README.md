# Generator ofert PRO MAX WOW

## Start
```bash
npm install
npm start
```

## Nowości w tej wersji
- usunięte pole i blok PDF `Typ oferty`
- termin w ofercie jako `data od - data do`
- każda sekcja ma własną `ilość dni`
- pozycje dodatkowe mają własną `ilość dni` i cenę liczoną per dzień
- w sekcji Starlink jest osobne pole `Cena Starlink / dzień`
- zapis szkiców na serwerze oraz opcjonalnie do folderu GitHub

## GitHub drafts
Ustaw w Render / środowisku:
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH=main`
- `GITHUB_DRAFTS_PATH=drafts`

Po ustawieniu tych zmiennych szkice będą zapisywane jako pliki JSON w folderze repozytorium, np. `drafts/OF-2026-031.json`.
