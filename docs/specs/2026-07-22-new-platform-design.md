# Дизайн новой платформы для разметки и обучения (эндоскопия)

## Контекст

Текущий проект (`medical_segmentation`, Django-монолит) — рабочий инструмент для
последовательной (видео) и изолированной (кадр) разметки эндоскопических данных:
классификация, сегментация (SAM-2), bbox (YOLO11/RT-DETRv2), с последующим обучением
моделей (YOLO, DINOv2/v3, ConvNeXT). Проект рос добавлением модулей без единой
архитектуры:

- Бизнес-логика и вызовы ML вперемешку в `views.py` (`data_preparation` — 1761 строк,
  `nettrain` — 839, `segmentation` — 1059), инференс вызывается синхронно из HTTP-запроса.
- `Tag` (`data_preparation/models.py`) совмещает анатомические лендмарки, патологии и
  тип классификации (`geometric`/`morphological`) в одной модели, при этом уже тяготеет
  к графу (`TagRelation` parent/child + confidence), но не является полноценной графовой БД.
- Медиа (видео, кадры, маски, веса моделей) — ~15GB плоско под `MEDIA_ROOT` без чёткой
  структуры и версионирования.
- Результаты обучения — `JSONField` на `NeuralNetworkVersion`, без истории запусков,
  без сравнения экспериментов, без live-графиков.
- SAM-2 используется только через point/box prompts; SAM-3 (promptable concept
  segmentation через текст/примеры) и YOLO26 уже вышли, но интеграция в текущую
  архитектуру потребовала бы переписывания вызовов по всем views.

Старый проект остаётся источником инженерных решений (что сработало, какие сущности
нужны предметной области), но новый продукт строится с нуля — не как 1:1 порт, а как
переосмысление функциональности с современной архитектурой.

## Лицензирование, язык и атрибуция

Проект публикуется под лицензией **Apache 2.0** как некоммерческий, поэтому это влияет
на структуру репозитория с первого коммита, а не добавляется постфактум:

- **Язык — только английский.** Код-комментарии, docstrings, README, документация в
  `docs/`, UI-тексты — всё на английском. Русский используется только в разговоре с
  пользователем, не попадает в репозиторий.
- **`LICENSE`** — полный текст Apache 2.0 в корне репозитория.
- **`NOTICE`** — обязательный для Apache 2.0 файл с атрибуцией: авторство проекта
  (имя/контакт создателя) и атрибуция сторонних моделей/библиотек, на которых построен
  ML-функционал (SAM, YOLO, DINOv3, RT-DETR и т.д. — по аналогии с разделом
  "Technologies Used" в README старого проекта, но оформлено как формальный
  third-party notices файл).
- **`README.md`** — включает секцию с атрибуцией автора/контактов и краткие ссылки/цитаты
  на используемые модели, на английском.
- Эти файлы создаются в самом начале работы над новым репозиторием (не как
  завершающий шаг), поскольку определяют тон и формат всей последующей документации.

## Пользователи

Небольшая команда разметчиков (несколько человек одновременно), нужен общий доступ
с ролями и конкурентный доступ к одним и тем же видео/кадрам.

## Архитектура верхнего уровня

Модульный монолит на FastAPI (не набор микросервисов — overhead не оправдан для
маленькой команды, но домены разделены как независимые Python-пакеты со своими
`router.py` / `models.py` / `service.py`) + отдельный GPU ML-воркер, обвязанные React SPA.

```
┌─────────────────────────┐
│   React SPA (Vite)      │
│  Zustand + TanStack Q.   │
└───────────┬──────────────┘
            │ REST (OpenAPI → generated TS client)
┌───────────▼──────────────────────────────────────────┐
│              Core API (FastAPI monolith)              │
│  ┌───────────┬───────────┬────────────┬─────────────┐ │
│  │  auth     │ taxonomy  │  media     │ annotation  │ │
│  ├───────────┼───────────┼────────────┼─────────────┤ │
│  │ datasets  │ training  │  jobs      │             │ │
│  └───────────┴───────────┴────────────┴─────────────┘ │
└──────┬───────────────────┬───────────────────┬────────┘
       │                   │                   │
       ▼                   ▼                   ▼
 PostgreSQL          Redis (Celery)      MinIO (S3 API)
                            │
                            ▼
              ┌─────────────────────────┐
              │   ML Worker (FastAPI +   │
              │   Celery, GPU-процесс)   │
              │  SAM adapter / YOLO /    │
              │  DINOv3 / RT-DETR / …    │
              └─────────────────────────┘
```

Деплой: один локальный/on-prem сервер с GPU (данные не должны уходить в облако).
`docker compose` для оркестрации сервисов (API, worker, Postgres, Redis, MinIO, MLflow).

## Технологический стек

| Слой | Выбор | Почему |
|---|---|---|
| Backend framework | FastAPI везде (core API и ML worker) | Единый язык/стек, автогенерация OpenAPI, асинхронность, меньше когнитивной нагрузки для небольшой команды |
| БД | PostgreSQL (JSONB + рекурсивные CTE для иерархии тегов) | Реляционная БД остаётся источником истины для транзакционных данных; иерархия — через closure/CTE, не нужна отдельная графовая БД; pgvector — для embeddings (поиск похожих кадров, как раньше делалось через DINOv3) |
| Очередь задач | Celery + Redis | Долгие GPU-задачи: retry, приоритеты, progress tracking, отдельные очереди под разные GPU-воркеры; Redis также для pub/sub статусов |
| Объектное хранилище | MinIO (S3-совместимое API) | Локально сейчас, но абстракция позволяет позже переехать в облако без переписывания кода; чёткая структура путей и версионирование с первого дня |
| Experiment tracking | MLflow | Версionирование запусков обучения, сравнение экспериментов, live-графики, artifact store для весов; `ModelVersion` в нашей БД хранит только `mlflow_run_id` |
| Frontend | React (Vite) + Tailwind | SPA вместо server-side шаблонов Django |
| UI-тема | Dark как default (Tailwind dark-mode strategy с первого дня) | Light-тема не реализуется сразу, но точка расширения закладывается в дизайн-токенах, чтобы не переделывать компоненты позже |
| Server state | TanStack Query | Кэширование/инвалидация серверных данных (списки видео, тегов, задач) |
| Client/UI state | Zustand | Локальный UI-state annotation workspace (текущий кадр, активный инструмент, несохранённые точки SAM) — не смешивается с серверными данными |
| API-контракт | REST + OpenAPI, автогенерация TS-типов | FastAPI генерирует OpenAPI из коробки; клиент и типы на фронте генерируются автоматически — контракт не расходится |
| Job-прогресс на фронте | SSE с fallback на polling через TanStack Query `refetchInterval` | Проще WebSocket для one-way прогресс-стрима, меньше инфраструктуры |

## Домены (backend-модули)

Ключевое отличие от старого проекта: taxonomy, media и annotation — три независимых
модуля с чёткими границами, а не переплетённые как `Tag`/`Sequences`/`FrameSequence`
сейчас.

- **`auth`** — пользователи, роли (annotator / reviewer / admin), JWT-сессии.
- **`taxonomy`** — `Label`, `LabelType` (geometric / morphological / quality / …),
  `LabelRelation` (parent/child + confidence), `Procedure`. Версионируется отдельно:
  можно завести новую версию таксономии, не инвалидируя старые аннотации — они хранят
  снапшот `label_id` + `taxonomy_version`.
- **`media`** — `Video`, `Sequence`, `Frame` — только факт существования файла и
  метаданные (width/height/fps/checksum/phash). Бинарные данные — в MinIO через единый
  `StorageService`. Никакой ML-логики.
- **`annotation`** — единая полиморфная модель `Annotation` вместо раздельных
  Mask/BBox/ClassificationLabel: один аудит-трейл, один workflow ревью/статусов для
  всех типов разметки. `payload` (JSONB) хранит специфику типа (точки маски, координаты
  bbox, prompt, из которого получена маска). Расширение на новые типы разметки
  (например keypoints) не требует новой таблицы.
- **`jobs`** — общая абстракция асинхронной задачи (SAM-инференс, экстраполяция маски
  по последовательности кадров, экспорт датасета, обучение модели). Хранит тип, статус,
  прогресс, payload, ссылку на результат. Celery-таски пишут сюда прогресс.
- **`datasets`** — сборка датасета из annotation-снапшотов под конкретную задачу
  (detection/segmentation/classification), экспорт в YOLO/COCO, метрики баланса классов
  (аналог текущего `DatasetBalanceAnalyzer`, но как сервис, а не метод модели).
- **`training`** — `ModelVersion`: ссылка на MLflow run, связь с датасетом и с
  моделью-родителем для fine-tuning.

## Модель данных (ключевые сущности)

```
Taxonomy:
  Label(id, name, label_type[geometric|morphological|quality], color, procedure_id, taxonomy_version)
  LabelRelation(parent_id, child_id, confidence)   -- рекурсивный CTE для иерархии

Media:
  Video(id, storage_key, title, fps, duration, checksum)
  Sequence(id, video_id, start_time, duration, crop_box)
  Frame(id, sequence_id, storage_key, index, width, height, phash)  -- phash: similar-frame detection

Annotation:
  Annotation(id, frame_id, label_id, taxonomy_version, type[mask|bbox|classification],
             payload JSONB,  -- {points:[...]} | {x,y,w,h} | {}
             status[draft|reviewed|rejected], created_by, reviewed_by,
             storage_key nullable)  -- растровая маска в MinIO при type=mask

Jobs:
  Job(id, type[sam_infer|extrapolate|export|train], status, progress, payload JSONB,
      result_ref, error, created_by, started_at, finished_at)

Datasets:
  Dataset(id, name, task_type, taxonomy_version, split_config JSONB, balance_metrics JSONB)
  DatasetItem(dataset_id, frame_id, annotation_ids[], split[train|val|test])

Training:
  ModelVersion(id, name, task_type, base_model_id, dataset_id, mlflow_run_id, storage_key, is_active)
```

Важные решения:
- `taxonomy_version` пришит и к `Annotation`, и к `Dataset` — изменение таксономии не
  ломает молча старые аннотации, видно, к какой версии схемы они относятся.
- Prompt (точки/box/текст), из которого SAM получил маску, сохраняется вместе с
  результатом — это позволяет переинференсить на новой версии SAM без потери исходного
  ввода пользователя.
- Растровые маски — в MinIO, а не как файловое поле модели; доступ только через
  `StorageService`.

## ML-сервис: adapter-паттерн

> **Актуализация (2026-07-22, после написания walking-skeleton плана):** на
> момент написания этого раздела SAM-3 и YOLO26 упоминались как будущие
> версии, к которым архитектура должна быть готова. С тех пор SAM-3 и
> YOLO26 вышли и стали основными целевыми моделями проекта — секция ниже
> переписана под это. История решения зафиксирована в `ROADMAP.md`.

Единый интерфейс адаптеров, не зависящий от конкретной модели — смена
активной версии (SAM point/box/text/exemplar-варианты, YOLO11/12/26,
детекторы) является добавлением нового адаптера и переключением конфига,
без переписывания API или UI:

```python
Prompt = PointPrompt | BoxPrompt | TextPrompt | ExemplarPrompt  # SAM-3 использует все четыре формы

class SegmentationAdapter(Protocol):
    def predict(self, frame: bytes, prompts: list[Prompt]) -> MaskResult: ...
    def track(self, sequence: list[bytes], prompts: list[Prompt]) -> list[MaskResult]: ...

class DetectionAdapter(Protocol):
    def predict(self, frame: bytes) -> list[Detection]: ...
    def train(self, dataset_ref: str, config: dict) -> TrainRun: ...
```

Конкретные реализации регистрируются в реестре по имени/версии:

- **Сегментация:** `Sam3Adapter` — основная модель. SAM-3 поддерживает все
  четыре формы промпта (point, box, text, exemplar-изображение), поэтому
  `Prompt`-абстракция используется полностью, а не как задел на будущее.
  `Sam2Adapter` остаётся в реестре как более лёгкая/быстрая альтернатива,
  если понадобится (не приоритет).
- **Детекция (Ultralytics-семейство):** `Yolo11Adapter`, `Yolo12Adapter`,
  `Yolo26Adapter` — три отдельные реализации `DetectionAdapter`, каждая
  под свою версию Ultralytics YOLO. Версия выбирается за job, а не глобально
  для сервиса: `Job.payload = {"adapter": "yolo26", "prompts": [...]}` —
  воркер резолвит адаптер по этому имени, разные job'ы могут использовать
  разные версии параллельно без переключения общего состояния сервиса.
- **Детекция (transformer-based):** `RtDetrV2Adapter` (RT-DETRv2) и
  `RfDetrAdapter` (RF-DETR) — второй входит в реестр как класс, реализующий
  `DetectionAdapter`, на уровне интерфейса/заглушки (`predict`/`train` могут
  первое время не иметь рабочей реализации) — модель ещё не интегрируется,
  но точка расширения существует, чтобы включение не требовало
  переписывания API/UI.

`Job.payload` указывает `{"adapter": "<имя>", ...}` — воркер грузит веса
нужного адаптера лениво и кэширует на узле; веса хранятся в MinIO.

## Frontend

Один SPA с двумя разделами (annotation workspace и training dashboard), общий auth и
навигация; разные роли видят разные разделы.

```
src/
  app/               — роутинг, layout, providers (QueryClient, auth)
  features/
    annotation/      — Workspace: video/frame viewer, canvas для масок/bbox,
                        SAM point-prompt UI, tag panel
                        state: useAnnotationStore (Zustand) — текущий кадр,
                        активный инструмент, несохранённые точки
    taxonomy/        — CRUD лейблов/иерархии
    datasets/        — сборка/экспорт датасетов, баланс-метрики
    training/        — список ModelVersion, статус job'ов, ссылка на MLflow UI
    media/           — загрузка видео, список sequence/frame
  entities/          — переиспользуемые доменные хуки на TanStack Query
                        (useFrames, useAnnotations, useLabels — тонкие обёртки
                        над generated API client)
  shared/
    ui/              — kit компонентов (Tailwind + headless, напр. Radix)
    api/             — сгенерированный из OpenAPI клиент + типы
    lib/             — canvas-утилиты, форматтеры
```

## Явно вне рамок этого документа

- Точный список ролей/прав доступа (roles/permissions matrix) — уточняется на этапе
  плана реализации auth-модуля.
- Схема миграции существующих ~15GB данных из старого `MEDIA_ROOT`/SQLite в новую
  структуру — отдельная задача после того, как новая платформа готова принимать данные.
- Реальная интеграция каждого адаптера (загрузка весов, инференс, обучение) —
  архитектура закладывает точку расширения (adapter registry, см. раздел
  "ML-сервис: adapter-паттерн" выше), сама интеграция каждой модели —
  отдельная работа по мере необходимости. На момент актуализации этого
  документа (2026-07-22) `RfDetrAdapter` предполагается как
  интерфейс-заглушка без рабочего инференса до отдельного решения о полной
  интеграции RF-DETR.
