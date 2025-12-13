# UAH DriveSet Web Viewer

Web local para ver un video de un viaje y el gráfico del acelerómetro sincronizado (UAH-DriveSet v1).

## Requisitos

- Python 3.10+

## Instalación

Desde la carpeta `uah_driveset_web_viewer`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Ejecutar

El backend asume que el dataset está en `../UAH-DRIVESET-v1`.

```bash
uvicorn backend.main:app --reload --port 8000
```

Abrí en el navegador:

- <http://127.0.0.1:8000>

## Dataset en otra ubicación

Podés indicar otra ruta con la variable de entorno `UAH_DATASET_ROOT`:

```bash
UAH_DATASET_ROOT="/ruta/a/UAH-DRIVESET-v1" uvicorn backend.main:app --reload --port 8000
```

## Cómo funciona la sincronización

Se calcula un offset en segundos:

- `dataStartDatetime`: timestamp del nombre de la carpeta del viaje
- `videoStartDatetime`: timestamp del nombre del archivo `.mp4`
- `offsetSeconds = dataStartDatetime - videoStartDatetime`

Luego, en el frontend:

- `t_data = video.currentTime - offsetSeconds`

El cursor del gráfico sigue `t_data`.
