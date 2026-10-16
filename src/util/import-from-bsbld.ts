import { MonoColour } from '@railmapgen/rmg-palette-resources';
import { MultiDirectedGraph } from 'graphology';
import stations from '../components/svgs/stations/stations';
import { ActionRow, LineElement, LineGroup, TimelineLine } from '../constants/timeline';
import {
    CityCode,
    EdgeAttributes,
    GraphAttributes,
    LineId,
    NodeAttributes,
    NodeId,
    NodeVersion,
    Theme,
} from '../constants/constants';
import { LinePathType, LineStyleType } from '../constants/lines';
import { StationType } from '../constants/stations';
import { MAP_COMMON_ZOOM, MAP_TILE_SIZE, worldPixelToGraph } from '../map/map-config';
import { autoPopulateTransfer, autoUpdateStationType, changeNodesColorInBatch } from './change-types';
import { toChordCoordinates } from './geometry';
import { getActionLineSuggestedDuration } from './video-export';
import { getEdgeMileageInKilometers } from './map-distance';
// bsbld 架空坐标按 1 个 bsbld 坐标单位 = 1 km；导入 RMP 时放大为 100 个图形单位。
const BSBld_GRAPH_UNITS_PER_KILOMETER = 100;
const BSBld_OVERVIEW_DURATION = 9;
const BSBld_WAIT_DURATION = 2;
const BSBld_FOCUS_DURATION = 4;

const quadraticPoint = (
    t: number,
    start: { x: number; y: number },
    control: { x: number; y: number },
    end: { x: number; y: number }
) => {
    const inverse = 1 - t;
    return {
        x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
        y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
    };
};

const quadraticLengthInKilometers = (
    start: { x: number; y: number },
    control: { x: number; y: number },
    end: { x: number; y: number }
) => {
    let length = 0;
    let previous = start;
    for (let index = 1; index <= 16; index += 1) {
        const current = quadraticPoint(index / 16, start, control, end);
        length += Math.hypot(current.x - previous.x, current.y - previous.y);
        previous = current;
    }
    return Number((length / BSBld_GRAPH_UNITS_PER_KILOMETER).toFixed(1));
};

const appendBsbldCameraActions = (rows: ActionRow[]): ActionRow[] =>
    rows.flatMap((row, index) => {
        const cameraRows: ActionRow[] = [
            {
                id: `${row.id}_overview`,
                date: '',
                activeLineIds: [],
                remark: '',
                actionType: 'overview',
                actionDuration: BSBld_OVERVIEW_DURATION,
            },
            {
                id: `${row.id}_wait`,
                date: '',
                activeLineIds: [],
                remark: '',
                actionType: 'wait',
                actionDuration: BSBld_WAIT_DURATION,
            },
        ];
        if (index < rows.length - 1) {
            cameraRows.push({
                id: `${row.id}_focus`,
                date: '',
                activeLineIds: [],
                remark: '',
                actionType: 'focus',
                actionDuration: BSBld_FOCUS_DURATION,
            });
        }
        return [row, ...cameraRows];
    });

export interface BsbldTimeline {
    totalDuration: number;
    currentTime: number;
    dateRows: [];
    groups: LineGroup[];
    lines: TimelineLine[];
    actionRows: ActionRow[];
    diffs: [];
}

export interface BsbldImportResult {
    fictionalMode: boolean;
    timeline?: BsbldTimeline;
}

interface BsbldPoint {
    id: number;
    x?: number;
    y?: number;
    lng?: number;
    lat?: number;
    lon?: number;
    sta?: boolean | number;
    staid?: number;
}

interface BsbldName {
    staid: number;
    name?: string;
}

interface BsbldLine {
    id: number;
    pts: number[];
    color?: string;
    name?: string;
}

interface BsbldTimeVar {
    key: string;
    value: string;
}

interface BsbldHistoryStation {
    id: number | string;
    staid: number;
    ptId: number;
    action: string;
    time: string;
}

interface BsbldHistorySegment {
    id: number | string;
    connector?: unknown;
    ownerId?: number | string;
    lineId?: number | string;
    connId?: number | string;
    action: string;
    time: string;
    fromPtId?: number;
    toPtId?: number;
    fromIdx?: number;
    toIdx?: number;
}

interface BsbldBackgroundImage {
    origW?: number;
    origH?: number;
    widthKm?: number;
    heightKm?: number;
}

interface BsbldSave {
    fictionalMode: boolean;
    pts: BsbldPoint[];
    lines: BsbldLine[];
    names: BsbldName[];
    bgImages?: BsbldBackgroundImage[];
    timeVars?: BsbldTimeVar[];
    historySegments?: BsbldHistorySegment[];
    historyStations?: BsbldHistoryStation[];
}

interface BsbldWork {
    format: 'BinshuLD3Work';
    schemaVersion: number;
    document: BsbldSave;
}

const isBsbldDocument = (data: unknown): data is BsbldSave => {
    if (!data || typeof data !== 'object') return false;
    const save = data as Partial<BsbldSave>;
    return (
        typeof save.fictionalMode === 'boolean' &&
        Array.isArray(save.pts) &&
        Array.isArray(save.lines) &&
        Array.isArray(save.names) &&
        save.pts.every(point => point && typeof point.id === 'number') &&
        save.lines.every(line => line && typeof line.id === 'number' && Array.isArray(line.pts))
    );
};

const getBsbldDocument = (data: unknown): BsbldSave | undefined => {
    if (isBsbldDocument(data)) return data;
    if (!data || typeof data !== 'object') return undefined;
    const work = data as Partial<BsbldWork>;
    return work.format === 'BinshuLD3Work' && typeof work.schemaVersion === 'number' && isBsbldDocument(work.document)
        ? work.document
        : undefined;
};

export const isBsbldSave = (data: unknown): boolean => getBsbldDocument(data) !== undefined;

const isHexColor = (value: string | undefined): value is `#${string}` =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

const projectLngLat = (lng: number, lat: number) => {
    const scale = MAP_TILE_SIZE * 2 ** MAP_COMMON_ZOOM;
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const world = {
        x: ((lng + 180) / 360) * scale,
        y: ((1 - Math.asinh(Math.tan((clampedLat * Math.PI) / 180)) / Math.PI) / 2) * scale,
    };
    return worldPixelToGraph(world);
};

const FICTIONAL_LNGLAT_SCALE = 100;

interface LngLatOrigin {
    lng: number;
    lat: number;
}

const fictionalLngLatOrigin = (points: BsbldPoint[]): LngLatOrigin | undefined => {
    const lngLatPoints = points.filter(
        point =>
            typeof point.x !== 'number' &&
            typeof point.y !== 'number' &&
            typeof (point.lng ?? point.lon) === 'number' &&
            typeof point.lat === 'number'
    );
    if (!lngLatPoints.length) return undefined;

    return {
        lng: lngLatPoints.reduce((sum, point) => sum + (point.lng ?? point.lon ?? 0), 0) / lngLatPoints.length,
        lat: lngLatPoints.reduce((sum, point) => sum + (point.lat ?? 0), 0) / lngLatPoints.length,
    };
};

const pointPosition = (point: BsbldPoint, fictionalMode: boolean, origin?: LngLatOrigin) => {
    if (typeof point.x === 'number' && typeof point.y === 'number') {
        return fictionalMode
            ? { x: point.x * BSBld_GRAPH_UNITS_PER_KILOMETER, y: point.y * BSBld_GRAPH_UNITS_PER_KILOMETER }
            : { x: point.x, y: point.y };
    }

    const lng = point.lng ?? point.lon;
    const lat = point.lat;
    if (typeof lng === 'number' && typeof lat === 'number') {
        return fictionalMode
            ? {
                  x: (lng - (origin?.lng ?? 0)) * FICTIONAL_LNGLAT_SCALE,
                  y: -(lat - (origin?.lat ?? 0)) * FICTIONAL_LNGLAT_SCALE,
              }
            : projectLngLat(lng, lat);
    }

    return { x: point.x ?? 0, y: point.y ?? 0 };
};

const bsbldControlPoint = (
    current: { x: number; y: number },
    previous: { x: number; y: number } | undefined,
    next: { x: number; y: number } | undefined,
    reverse: boolean,
    segmentLength: number
) => {
    const before = previous ?? current;
    const after = next ?? current;
    let dx = after.x - before.x;
    let dy = after.y - before.y;
    if (reverse) {
        dx = -dx;
        dy = -dy;
    }
    const length = Math.hypot(dx, dy);
    if (length < 1e-12) return current;
    const distance = Math.min(length * 0.35, segmentLength * 0.35 * 1.5);
    return { x: current.x + (dx / length) * distance, y: current.y + (dy / length) * distance };
};

const bsbldQuadraticControl = (
    source: { x: number; y: number },
    sourceControl: { x: number; y: number },
    targetControl: { x: number; y: number },
    target: { x: number; y: number }
) => ({
    x: (3 * (sourceControl.x + targetControl.x) - source.x - target.x) / 4,
    y: (3 * (sourceControl.y + targetControl.y) - source.y - target.y) / 4,
});

const toIsoDate = (value: string): string | undefined => {
    const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value.trim());
    if (!match) return undefined;
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
        date.getUTCFullYear() !== Number(year) ||
        date.getUTCMonth() !== Number(month) - 1 ||
        date.getUTCDate() !== Number(day)
    ) {
        return undefined;
    }
    return date.toISOString().slice(0, 10);
};

const resolveHistoryDate = (time: string, timeVars: Map<string, string>): string => {
    const directDate = toIsoDate(time);
    if (directDate) return directDate;
    const expression = /^([a-zA-Z_][\w]*)([+-].+)$/.exec(time.trim());
    if (!expression) return time;
    const [, key, offsets] = expression;
    const baseDate = toIsoDate(timeVars.get(key) ?? '');
    if (!baseDate) return time;
    const result = new Date(`${baseDate}T00:00:00Z`);
    const offsetPattern = /([+-])(\d+)([ymd])/g;
    let match: RegExpExecArray | null;
    while ((match = offsetPattern.exec(offsets))) {
        const amount = (match[1] === '+' ? 1 : -1) * Number(match[2]);
        if (match[3] === 'y') result.setUTCFullYear(result.getUTCFullYear() + amount);
        if (match[3] === 'm') result.setUTCMonth(result.getUTCMonth() + amount);
        if (match[3] === 'd') result.setUTCDate(result.getUTCDate() + amount);
    }
    return result.toISOString().slice(0, 10);
};

type HistoryEvent = {
    date: string;
    order: number;
    actionType: 'open' | 'close';
    lineId?: number;
    stationNodeId?: NodeId;
    stationPointIds: number[];
    timelineLineId: string;
};

type StationHistoryState = { lines: Set<number>; open: boolean };

type StationHistorySnapshot = {
    versions: Map<NodeId, number>;
    visibility: Map<NodeId, boolean>;
};

const getStationTypePair = (type: StationType): [StationType, StationType] => {
    if (type.endsWith('-int')) return [type.replace(/-int$/, '-basic') as StationType, type];
    if (type.endsWith('-basic')) return [type, type.replace(/-basic$/, '-int') as StationType];
    return [type, type];
};

const getStyleSignature = (stationType: StationType, lineIds: number[], colors: Map<number, string>): string => {
    const ids = [...new Set(lineIds)].sort((a, b) => a - b);
    const colorValues = ids.map(id => colors.get(id) ?? `line:${id}`);
    const isBasic = ids.length < 2;
    const city = stationType.split('-')[0];
    if (city === 'bjsubway' || city === 'shmetro') return isBasic ? 'basic' : 'int';
    if (city === 'wuhanrt') return isBasic ? `basic:${colorValues[0] ?? ''}` : `int:${ids.length >= 3 ? '3+' : '2'}`;
    if (city === 'chengdurt') return isBasic ? `basic:${colorValues[0] ?? ''}` : 'int';
    if (city === 'suzhourt') return isBasic ? `basic:${colorValues[0] ?? ''}` : `int:${ids.join(',')}`;
    if (city === 'csmetro' || city === 'hzmetro' || city === 'kunmingrt') {
        const limit = isBasic ? 1 : city === 'csmetro' ? 2 : 3;
        return `${isBasic ? 'basic' : 'int'}:${colorValues.slice(0, limit).join(',')}`;
    }
    return isBasic ? `basic:${colorValues[0] ?? ''}` : `int:${colorValues.join(',')}`;
};

const prepareStationHistory = (
    save: BsbldSave,
    nodeByPointId: Map<number, NodeId>,
    graph: MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>,
    stationType: StationType,
    lineColors: Map<number, string>,
    events: HistoryEvent[]
) => {
    const states = new Map<NodeId, StationHistoryState>();
    const caches = new Map<NodeId, Map<string, number>>();
    const snapshots = new Map<string, StationHistorySnapshot>();
    const visibilitySnapshots = new Map<string, Map<NodeId, boolean>>();
    const eventSnapshots = new Map<string, { before: StationHistorySnapshot; after: StationHistorySnapshot }>();
    const stationNodes = [
        ...new Set(
            save.pts
                .filter(p => p.sta && p.staid !== undefined)
                .map(p => nodeByPointId.get(p.id))
                .filter((id): id is NodeId => !!id)
        ),
    ];
    const makeVersion = (nodeId: NodeId, lineIds: number[] = []): number => {
        const attrs = graph.getNodeAttributes(nodeId);
        const signature = getStyleSignature(stationType, lineIds, lineColors);
        let cache = caches.get(nodeId);
        if (!cache) caches.set(nodeId, (cache = new Map()));
        const existing = cache.get(signature);
        if (existing) return existing;
        const version = (attrs.versions?.length ?? 0) + 1;
        const [basicType, intType] = getStationTypePair(stationType);
        const historicalType = lineIds.length >= 2 ? intType : basicType;
        const baseAttrs = structuredClone({
            ...(stations[historicalType].defaultAttrs as unknown as Record<string, unknown>),
            ...((attrs[historicalType] ?? {}) as Record<string, unknown>),
            ...((attrs[stationType] ?? {}) as Record<string, unknown>),
        }) as Record<string, unknown>;
        const orderedLineIds = [...new Set(lineIds)].sort((a, b) => a - b);
        const colors = [...new Set(orderedLineIds.map(id => lineColors.get(id) ?? `line:${id}`))];
        if ('color' in baseAttrs && colors[0]) {
            baseAttrs.color = [CityCode.Other, `bsbld-${orderedLineIds[0]}`, colors[0], MonoColour.white];
        }
        if ('transfer' in baseAttrs) {
            baseAttrs.transfer = [
                [...new Set(lineIds)]
                    .sort((a, b) => a - b)
                    .map(id => [
                        CityCode.Other,
                        `bsbld-${id}`,
                        lineColors.get(id) ?? '#000000',
                        MonoColour.white,
                        '',
                        '',
                    ]),
            ];
        }
        const snapshot: NodeVersion = {
            version,
            name: lineIds.length >= 2 ? `换乘站${version}` : `普通站${version}`,
            x: attrs.x,
            y: attrs.y,
            type: historicalType,
            [historicalType]: baseAttrs,
        } as NodeVersion;
        graph.updateNodeAttribute(nodeId, 'versions', versions => [...(versions ?? []), snapshot]);
        cache.set(signature, version);
        return version;
    };
    stationNodes.forEach(nodeId => {
        const attrs = graph.getNodeAttributes(nodeId);
        const version: NodeVersion = {
            version: 1,
            name: '普通站1',
            x: attrs.x,
            y: attrs.y,
            type: attrs.type,
            [attrs.type]: structuredClone(attrs[attrs.type]),
        } as NodeVersion;
        graph.setNodeAttribute(nodeId, 'versions', [version]);
        caches.set(nodeId, new Map([[getStyleSignature(stationType, [], lineColors), 1]]));
        states.set(nodeId, { lines: new Set(), open: false });
    });
    const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
    let index = 0;
    const capture = (): StationHistorySnapshot => {
        const versions = new Map<NodeId, number>();
        const visibility = new Map<NodeId, boolean>();
        stationNodes.forEach(nodeId => {
            const state = states.get(nodeId) ?? { lines: new Set<number>(), open: false };
            versions.set(nodeId, makeVersion(nodeId, [...state.lines]));
            visibility.set(nodeId, state.open || state.lines.size > 0);
        });
        return { versions, visibility };
    };
    while (index < sorted.length) {
        const date = sorted[index].date;
        const batch: HistoryEvent[] = [];
        while (index < sorted.length && sorted[index].date === date) batch.push(sorted[index++]);
        const dateBefore = capture();
        batch.forEach((event, eventIndex) => {
            const before = capture();
            const affected = event.stationNodeId
                ? [event.stationNodeId]
                : event.stationPointIds.map(p => nodeByPointId.get(p)).filter((id): id is NodeId => !!id);
            affected.forEach(nodeId => {
                const state = states.get(nodeId) ?? { lines: new Set<number>(), open: false };
                if (event.lineId !== undefined) {
                    if (event.actionType === 'open') {
                        state.lines.add(event.lineId);
                    } else {
                        state.lines.delete(event.lineId);
                    }
                }
                if (event.stationNodeId === nodeId) state.open = event.actionType === 'open';
                states.set(nodeId, state);
            });
            const after = capture();
            eventSnapshots.set(event.timelineLineId, { before, after });
            if (eventIndex === batch.length - 1) {
                snapshots.set(`${date}:before`, dateBefore);
                snapshots.set(`${date}:after`, after);
                visibilitySnapshots.set(`${date}:after`, after.visibility);
            }
        });
    }
    return { snapshots, visibilitySnapshots, eventSnapshots, states };
};

const createTimeline = (
    save: BsbldSave,
    nodeByPointId: Map<number, NodeId>,
    edgeIdsByLine: Map<number, LineId[]>,
    graph: MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>,
    stationType: StationType,
    lineColors: Map<number, string>
): BsbldTimeline | undefined => {
    if (!save.historySegments?.length && !save.historyStations?.length) return undefined;

    const groups = new Map<number, LineGroup>();
    for (const line of save.lines) {
        groups.set(line.id, {
            id: `bsbld_group_${line.id}`,
            bgColor: isHexColor(line.color) ? line.color : '#000000',
            text: line.name?.trim() || `bsbld-${line.id}`,
        });
    }

    const timeVars = new Map((save.timeVars ?? []).map(({ key, value }) => [key, value]));
    const pointById = new Map(save.pts.map(point => [point.id, point]));
    const stationNames = new Map(save.names.map(name => [name.staid, name.name?.trim() ?? '']));
    const isStationPoint = (pointId: number | undefined): boolean => {
        const point = pointId === undefined ? undefined : pointById.get(pointId);
        return Boolean(point?.sta && point.staid !== undefined);
    };
    const getStationName = (pointId: number | undefined): string => {
        if (!isStationPoint(pointId)) return '';
        const point = pointById.get(pointId as number);
        return stationNames.get(point?.staid as number) ?? '';
    };
    const getTimelineLineName = (number: number | string, startPointId?: number, endPointId?: number): string => {
        const startName = getStationName(startPointId);
        const endName = getStationName(endPointId);
        return startName && endName ? `线路段${number} (${startName}-${endName})` : `线路段${number}`;
    };
    const lines: TimelineLine[] = [];
    const actionRows: ActionRow[] = [];
    const historyEvents: HistoryEvent[] = [];
    const addHistoryLine = (
        id: number | string,
        groupId: number,
        text: string,
        elements: LineElement[],
        time: string,
        actionType: 'open' | 'close'
    ) => {
        const timelineLineId = `bsbld_timeline_line_${id}`;
        const timelineLine: TimelineLine = {
            id: timelineLineId,
            groupId: `bsbld_group_${groupId}`,
            text,
            elements,
        };
        lines.push(timelineLine);
        actionRows.push({
            id: `bsbld_action_${id}`,
            date: resolveHistoryDate(time, timeVars),
            activeLineIds: [`bsbld_group_${groupId}`],
            remark: '',
            actionType,
            actionLineId: timelineLineId,
            actionDuration: getActionLineSuggestedDuration(timelineLine) * 0.5,
            useSuggestedDuration: false,
        });
    };

    for (const segment of save.historySegments ?? []) {
        const actionType =
            segment.action === 'open'
                ? 'open'
                : segment.action === 'close' || segment.action === 'abandon' || segment.action === 'remove'
                  ? 'close'
                  : undefined;
        if (!actionType || segment.connector) continue;
        const ownerId = Number(segment.ownerId ?? segment.lineId);
        const line = save.lines.find(candidate => candidate.id === ownerId);
        const group = groups.get(ownerId);
        if (!line || !group) continue;

        const fromIndex = Number.isInteger(segment.fromIdx)
            ? Number(segment.fromIdx)
            : segment.fromPtId === undefined
              ? -1
              : line.pts.indexOf(segment.fromPtId);
        const toIndex = Number.isInteger(segment.toIdx)
            ? Number(segment.toIdx)
            : segment.toPtId === undefined
              ? -1
              : line.pts.indexOf(segment.toPtId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) continue;

        const edgeIds = edgeIdsByLine.get(ownerId) ?? [];
        const start = Math.min(fromIndex, toIndex);
        const end = Math.max(fromIndex, toIndex);
        const indexes = Array.from({ length: end - start + 1 }, (_, offset) =>
            fromIndex > toIndex ? end - offset : start + offset
        );
        const elements = [];
        for (let offset = 0; offset < indexes.length; offset += 1) {
            const pointId = nodeByPointId.get(line.pts[indexes[offset]]);
            const edgeId =
                offset < indexes.length - 1 ? edgeIds[Math.min(indexes[offset], indexes[offset + 1])] : undefined;
            if (!pointId || (offset < indexes.length - 1 && !edgeId)) {
                elements.length = 0;
                break;
            }
            elements.push({ id: pointId });
            if (edgeId) elements.push({ id: edgeId, ...(fromIndex > toIndex ? { reverse: true } : {}) });
        }
        if (!elements.length) continue;

        const firstStationPointId = indexes.map(index => line.pts[index]).find(isStationPoint);
        const lastStationPointId = [...indexes]
            .reverse()
            .map(index => line.pts[index])
            .find(isStationPoint);
        const timelineLineId = `bsbld_timeline_line_${segment.id}`;
        const mileage = elements.reduce(
            (sum, element) =>
                graph.hasEdge(element.id) ? sum + Number(graph.getEdgeAttribute(element.id, 'mileage') ?? 0) : sum,
            0
        );
        const timelineLine: TimelineLine = {
            id: timelineLineId,
            groupId: group.id,
            text: getTimelineLineName(segment.id, firstStationPointId, lastStationPointId),
            elements,
            mileage: Number(mileage.toFixed(1)),
        };
        lines.push(timelineLine);
        const date = resolveHistoryDate(segment.time, timeVars);
        actionRows.push({
            id: `bsbld_action_${segment.id}`,
            date,
            activeLineIds: [group.id],
            remark: '',
            actionType,
            actionLineId: timelineLineId,
            actionDuration: getActionLineSuggestedDuration(timelineLine) * 0.5,
            useSuggestedDuration: false,
        });
        historyEvents.push({
            date,
            order: historyEvents.length,
            actionType,
            lineId: ownerId,
            stationPointIds: indexes.map(index => line.pts[index]),
            timelineLineId,
        });
    }

    for (const station of save.historyStations ?? []) {
        const actionType =
            station.action === 'open'
                ? 'open'
                : station.action === 'close' || station.action === 'remove'
                  ? 'close'
                  : undefined;
        if (!actionType) continue;
        const line = save.lines.find(candidate => candidate.pts.includes(station.ptId));
        const nodeId = nodeByPointId.get(station.ptId);
        if (!line || !nodeId) continue;
        const stationTimelineId = `bsbld_timeline_line_station_${station.id}`;
        addHistoryLine(
            `station_${station.id}`,
            line.id,
            getTimelineLineName(station.id, station.ptId, station.ptId),
            [{ id: nodeId }],
            station.time,
            actionType
        );
        historyEvents.push({
            date: resolveHistoryDate(station.time, timeVars),
            order: historyEvents.length,
            actionType,
            lineId: line.id,
            stationNodeId: nodeId,
            stationPointIds: [station.ptId],
            timelineLineId: stationTimelineId,
        });
    }

    if (!actionRows.length) return undefined;
    const history = prepareStationHistory(save, nodeByPointId, graph, stationType, lineColors, historyEvents);
    actionRows.forEach(row => {
        if (row.actionType !== 'open' && row.actionType !== 'close') return;
        const event = historyEvents.find(candidate => candidate.timelineLineId === row.actionLineId);
        if (!event) return;
        const eventSnapshot = history.eventSnapshots.get(event.timelineLineId);
        const snapshot = eventSnapshot?.[row.actionType === 'open' ? 'after' : 'before'];
        const versions = snapshot?.versions;
        const timelineLine = lines.find(line => line.id === row.actionLineId);
        timelineLine?.elements.forEach(element => {
            if (!graph.hasNode(element.id)) return;
            const version = versions?.get(element.id as NodeId);
            if (version && version > 1) element.version = version;
        });
        if (row.actionType === 'close') {
            const after = eventSnapshot?.after.versions;
            const visibility = eventSnapshot?.after.visibility;
            const closeNodeStyles: NonNullable<ActionRow['closeNodeStyles']> = {};
            const affected = event.stationNodeId
                ? [event.stationNodeId]
                : event.stationPointIds.map(pointId => nodeByPointId.get(pointId)).filter((id): id is NodeId => !!id);
            affected.forEach(nodeId => {
                const state = history.states.get(nodeId);
                if (state)
                    closeNodeStyles[nodeId] = {
                        visible: visibility?.get(nodeId) ?? state.lines.size > 0,
                        version: after?.get(nodeId) ?? 1,
                    };
            });
            if (Object.keys(closeNodeStyles).length) row.closeNodeStyles = closeNodeStyles;
        }
    });
    const importedActionRows = appendBsbldCameraActions(actionRows);
    return {
        totalDuration: importedActionRows.reduce((sum, row) => sum + (row.actionDuration ?? 0), 0),
        currentTime: 0,
        dateRows: [],
        groups: [...groups.values()],
        lines,
        actionRows: importedActionRows,
        diffs: [],
    };
};

export const convertBsbldToRmp = (
    text: string,
    graph: MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>,
    stationType: StationType = StationType.SuzhouRTBasic
): BsbldImportResult => {
    const data = JSON.parse(text) as unknown;
    const save = getBsbldDocument(data);
    if (!save) throw new Error('Invalid bsbld save data');

    const names = new Map(save.names.map(name => [name.staid, name.name ?? '']));
    const pointById = new Map(save.pts.map(point => [point.id, point]));
    const nodeByPointId = new Map<number, NodeId>();
    const nodeByStationId = new Map<number, NodeId>();
    const edgeIdsByLine = new Map<number, LineId[]>();
    const lngLatOrigin = save.fictionalMode ? fictionalLngLatOrigin(save.pts) : undefined;

    for (const point of save.pts) {
        const stationId = point.sta && typeof point.staid === 'number' && point.staid >= 0 ? point.staid : undefined;
        const existing = stationId === undefined ? undefined : nodeByStationId.get(stationId);
        if (existing) {
            nodeByPointId.set(point.id, existing);
            continue;
        }

        const id: NodeId = stationId === undefined ? `misc_node_bsbld_${point.id}` : `stn_bsbld_${stationId}`;
        const position = pointPosition(point, save.fictionalMode, lngLatOrigin);
        if (stationId === undefined) {
            graph.addNode(id, {
                visible: true,
                zIndex: 0,
                x: position.x,
                y: position.y,
                type: 'virtual',
                virtual: {},
            } as NodeAttributes);
        } else {
            const type = stationType;
            graph.addNode(id, {
                visible: true,
                zIndex: 1,
                x: position.x,
                y: position.y,
                type,
                [type]: { ...structuredClone(stations[type].defaultAttrs), names: [names.get(stationId) ?? '', ''] },
            } as NodeAttributes);
            nodeByStationId.set(stationId, id);
        }
        nodeByPointId.set(point.id, id);
    }

    for (const line of save.lines) {
        const points = line.pts
            .map(id => pointById.get(id))
            .filter((point): point is BsbldPoint => point !== undefined);
        const color = isHexColor(line.color) ? line.color : '#000000';
        const theme: Theme = [CityCode.Other, `bsbld-${line.id}`, color, MonoColour.white];
        const edgeIds: LineId[] = [];
        for (let index = 0; index < points.length - 1; index++) {
            const sourcePoint = points[index];
            const targetPoint = points[index + 1];
            const source = nodeByPointId.get(sourcePoint.id);
            const target = nodeByPointId.get(targetPoint.id);
            if (!source || !target || source === target) continue;
            const sourcePosition = pointPosition(sourcePoint, save.fictionalMode, lngLatOrigin);
            const targetPosition = pointPosition(targetPoint, save.fictionalMode, lngLatOrigin);
            const previousPosition =
                index >= 1 ? pointPosition(points[index - 1], save.fictionalMode, lngLatOrigin) : undefined;
            const nextPosition =
                index + 2 < points.length
                    ? pointPosition(points[index + 2], save.fictionalMode, lngLatOrigin)
                    : undefined;
            const segmentLength = Math.hypot(targetPosition.x - sourcePosition.x, targetPosition.y - sourcePosition.y);
            const sourceControl = bsbldControlPoint(
                sourcePosition,
                previousPosition,
                targetPosition,
                false,
                segmentLength
            );
            const targetControl = bsbldControlPoint(targetPosition, sourcePosition, nextPosition, true, segmentLength);
            const control = bsbldQuadraticControl(sourcePosition, sourceControl, targetControl, targetPosition);
            const local = toChordCoordinates(control, sourcePosition, targetPosition);
            const edgeId = `line_bsbld_${line.id}_${index}` as LineId;
            graph.addDirectedEdgeWithKey(edgeId, source, target, {
                visible: true,
                zIndex: 0,
                type: LinePathType.Bezier,
                style: LineStyleType.SingleColor,
                reconcileId: '',
                parallelIndex: -1,
                autoFillMileage: false,
                [LinePathType.Bezier]: { along: local?.x ?? 0.5, normal: local?.y ?? 0 },
                [LineStyleType.SingleColor]: { color: theme },
            } as EdgeAttributes);
            graph.setEdgeAttribute(
                edgeId,
                'mileage',
                save.fictionalMode
                    ? quadraticLengthInKilometers(sourcePosition, control, targetPosition)
                    : getEdgeMileageInKilometers(graph, edgeId)
            );
            changeNodesColorInBatch(
                graph,
                'any',
                theme,
                [source, target].filter((id): id is `stn_${string}` => id.startsWith('stn_')),
                []
            );
            edgeIds[index] = edgeId;
        }
        edgeIdsByLine.set(line.id, edgeIds);
    }

    nodeByStationId.forEach(id => {
        if (graph.hasNode(id)) {
            autoUpdateStationType(graph, id as `stn_${string}`);
            autoPopulateTransfer(graph, id as `stn_${string}`);
        }
    });

    return {
        fictionalMode: save.fictionalMode,
        timeline: createTimeline(
            save,
            nodeByPointId,
            edgeIdsByLine,
            graph,
            stationType,
            new Map(save.lines.map(line => [line.id, isHexColor(line.color) ? line.color : `line:${line.id}`]))
        ),
    };
};
