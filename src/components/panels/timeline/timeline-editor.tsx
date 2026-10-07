import {
    AlertDialog,
    AlertDialogBody,
    AlertDialogContent,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogOverlay,
    Badge,
    Box,
    Collapse,
    FormControl,
    FormLabel,
    Stack,
    Slider,
    SliderFilledTrack,
    SliderThumb,
    SliderTrack,
    Button,
    Flex,
    HStack,
    IconButton,
    Input,
    Modal,
    ModalBody,
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalOverlay,
    Select,
    Switch,
    Text,
    VStack,
    useColorModeValue,
    useToast,
} from '@chakra-ui/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    MdAdd,
    MdArrowBack,
    MdArrowDownward,
    MdArrowUpward,
    MdAutoFixHigh,
    MdChevronLeft,
    MdChevronRight,
    MdDelete,
    MdEdit,
    MdExpandMore,
    MdSwapHoriz,
    MdSchedule,
} from 'react-icons/md';
import { RmgSidePanel, RmgSidePanelBody, RmgSidePanelHeader } from '@railmapgen/rmg-components';
import type { SerializedGraph } from 'graphology-types';
import { useRootDispatch, useRootSelector } from '../../../redux';
import {
    addLineGroup,
    updateLineGroup,
    removeLineGroup,
    addTimelineLine,
    updateTimelineLine,
    removeTimelineLine,
    addActionRow,
    updateActionRow,
    removeActionRow,
    reorderActionRows,
    batchClearActionRowDates,
    clearValidationUndoPending,
    setUnsavedDate,
    clearUnsavedDraft,
} from '../../../redux/timeline/timeline-slice';
import { clearSelected, setSelected } from '../../../redux/runtime/runtime-slice';
import { setEnableActionDateFormatValidation } from '../../../redux/app/app-slice';
import { TimelineLine, LineElement, ActionRow, CloseNodeStyle, LineGroup } from '../../../constants/timeline';
import { Id, NodeId, Theme, EdgeAttributes, GraphAttributes, NodeAttributes } from '../../../constants/constants';
import { MiscNodeType } from '../../../constants/nodes';
import { StationType } from '../../../constants/stations';
import stations from '../../svgs/stations/stations';
import miscNodes from '../../svgs/nodes/misc-nodes';
import {
    findPathByTheme,
    findThemesAtNode,
    getNodeDisplayName,
    getNodeVersion,
    calculateAutoReverseForPath,
    getActionConstraintState,
} from '../../../util/timeline';
import { getActionLineMinimumDuration, getActionLineSuggestedDuration } from '../../../util/video-export';
import { resolveVirtualNodeToStation } from '../../../util/virtual-node-station';
import { LineInfoModal } from '../../page-header/line-info-modal';
import { getLineExports } from '../../../util/line-export';
import {
    getLineEndpointsLabel,
    getLineRoutes,
    getLineTopology,
    getStationLabel,
    LineRoute,
} from '../../../util/line-definitions';
import {
    getLineIntervalDiagram,
    INTERVAL_PADDING,
    INTERVAL_ROUTE_Y,
    INTERVAL_STATION_GAP,
} from '../../../util/line-interval-diagram';
import { LineDefinition } from '../../../constants/line-definitions';
import { getBatchAnchorIndex, isQuickCompleteAction } from '../../../util/action-schedule';
import ThemeButton from '../theme-button';
import TimelineColorPicker from './timeline-color-picker';
import InvalidDateModal from './invalid-date-modal';

/** Validate YYYY-MM-DD or YYYY/MM/DD date format (supports 1-2 digit month/day) */
const isValidDateFormat = (dateStr: string): boolean => {
    if (!dateStr) return true; // empty is valid for optional fields
    return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr);
};

interface TimelineEditorPanelProps {
    isOpen: boolean;
    onClose: () => void;
    zIndex?: number;
}

/**
 * 时间线编辑器侧边面板。
 * 上半区域：线路列表（一级）→ 线路段列表（二级，包含元素列表编辑）
 * 下半区域：动作列表管理
 */
const fitSvgViewBox = (svg: SVGSVGElement, padding = 8): string | null => {
    try {
        const target = svg.querySelector<SVGGElement>(':scope > g') ?? svg;
        const bbox = target.getBBox();
        if (!Number.isFinite(bbox.width) || !Number.isFinite(bbox.height) || (bbox.width === 0 && bbox.height === 0)) {
            return null;
        }
        return `${bbox.x - padding} ${bbox.y - padding} ${Math.max(1, bbox.width + padding * 2)} ${Math.max(
            1,
            bbox.height + padding * 2
        )}`;
    } catch {
        return null;
    }
};

type IntervalSelection = { key: string; start: number; end: number };

/**
 * 从已分配线路中选择连续区段的模态框。
 * 与「修改线路区间」一致的交互：起终点下拉、路径选择弹窗、SVG 区间图拖拽环。
 */
const SegmentFromLineModal = ({
    graph,
    line,
    onClose,
    onApply,
}: {
    graph: SerializedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>;
    line: LineDefinition;
    onClose: () => void;
    onApply: (route: LineRoute, start: number, end: number) => void;
}) => {
    const { t } = useTranslation();
    const topology = React.useMemo(() => getLineTopology(graph, line), [graph, line]);
    const isLoop = topology.type === 'LOOP';
    const [from, setFrom] = React.useState(line.exportStartStationId || topology.startCandidates[0] || '');
    const [to, setTo] = React.useState(topology.startCandidates.find(id => id !== from) || from);
    const [routeIndex, setRouteIndex] = React.useState(0);
    const [isPathPickerOpen, setIsPathPickerOpen] = React.useState(false);
    const [selection, setSelection] = React.useState<IntervalSelection>();
    const routes = React.useMemo(
        () => getLineRoutes(graph, line, from, isLoop ? from : to),
        [graph, line, from, to, isLoop]
    );
    const route = routes[Math.min(routeIndex, routes.length - 1)];
    const diagram = React.useMemo(() => route && getLineIntervalDiagram(graph, line, route), [graph, line, route]);
    const last = (route?.stationIds.length ?? 1) - 1;
    const end = selection?.key === route?.key ? Math.min(selection?.end ?? last, last) : last;
    const start = selection?.key === route?.key ? Math.min(selection?.start ?? 0, Math.max(0, end - 1)) : 0;
    const drag = React.useRef<{ handle: 'start' | 'end'; pointerId: number } | undefined>(undefined);
    const svgRef = React.useRef<SVGSVGElement>(null);
    const width = diagram?.width ?? 440;

    const move = (handle: 'start' | 'end', index: number) => {
        if (!route) return;
        setSelection({
            key: route.key,
            start: handle === 'start' ? Math.max(0, Math.min(index, end - 1)) : start,
            end: handle === 'end' ? Math.min(last, Math.max(index, start + 1)) : end,
        });
    };
    const swapArc = () => {
        if (!route || !isLoop) return;
        const a = route.stationIds[start],
            b = route.stationIds[end];
        if (a === b) return;
        const selected = new Set(route.segments.slice(start, end).flat());
        const options = getLineRoutes(graph, line, a, a);
        const index = options.findIndex(option => {
            const bIndex = option.stationIds.indexOf(b);
            return (
                bIndex > 0 &&
                option.segments
                    .slice(0, bIndex)
                    .flat()
                    .some(id => !selected.has(id))
            );
        });
        if (index < 0) return;
        setFrom(a);
        setRouteIndex(index);
        setSelection({ key: options[index].key, start: 0, end: options[index].stationIds.indexOf(b) });
    };
    const handleRing = (kind: 'start' | 'end', index: number, colour: string) => (
        <g
            role="slider"
            tabIndex={0}
            aria-label={t(`header.lineInfo.${kind === 'start' ? 'rangeStart' : 'rangeEnd'}`)}
            aria-valuemin={kind === 'start' ? 0 : start + 1}
            aria-valuemax={kind === 'start' ? end - 1 : last}
            aria-valuenow={index}
            aria-valuetext={route ? getStationLabel(graph, route.stationIds[index]) : ''}
            transform={`translate(${INTERVAL_PADDING + index * INTERVAL_STATION_GAP},${INTERVAL_ROUTE_Y})`}
            style={{ cursor: 'ew-resize', touchAction: 'none' }}
            onPointerDown={event => {
                if (event.button !== 0 || event.isPrimary === false) return;
                event.preventDefault();
                drag.current = { handle: kind, pointerId: event.pointerId };
                event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={event => {
                if (drag.current?.handle !== kind || drag.current.pointerId !== event.pointerId || !svgRef.current)
                    return;
                const rect = svgRef.current.getBoundingClientRect();
                if (rect.width)
                    move(
                        kind,
                        Math.round(
                            (((event.clientX - rect.left) * width) / rect.width - INTERVAL_PADDING) /
                                INTERVAL_STATION_GAP
                        )
                    );
            }}
            onPointerUp={event => {
                drag.current = undefined;
                event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => {
                drag.current = undefined;
            }}
            onLostPointerCapture={() => {
                drag.current = undefined;
            }}
            onKeyDown={event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    move(
                        kind,
                        event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? last
                              : index + (event.key === 'ArrowLeft' ? -1 : 1)
                    );
                }
            }}
        >
            <circle r="18" fill="transparent" stroke={colour} strokeWidth="4" />
            <text y="-33" textAnchor="middle" fill={colour} fontSize="13">
                {t(`header.lineInfo.${kind === 'start' ? 'rangeStart' : 'rangeEnd'}`)}
            </text>
        </g>
    );

    const pathPicker = (
        <Modal isOpen={isPathPickerOpen} onClose={() => setIsPathPickerOpen(false)} size="xl" scrollBehavior="inside">
            <ModalOverlay />
            <ModalContent>
                <ModalHeader>{t('header.lineInfo.pickPath')}</ModalHeader>
                <ModalCloseButton />
                <ModalBody>
                    <Stack spacing="2">
                        {routes.map((option, index) => (
                            <Button
                                key={option.key}
                                size="md"
                                h="auto"
                                py="2"
                                whiteSpace="normal"
                                variant={index === routeIndex ? 'solid' : 'outline'}
                                colorScheme="blue"
                                fontWeight="normal"
                                onClick={() => {
                                    setRouteIndex(index);
                                    setSelection(undefined);
                                    setIsPathPickerOpen(false);
                                }}
                            >
                                {option.stationIds.map(id => getStationLabel(graph, id)).join('—')}
                            </Button>
                        ))}
                    </Stack>
                </ModalBody>
            </ModalContent>
        </Modal>
    );

    return (
        <>
            <Modal isOpen onClose={onClose} size="4xl" scrollBehavior="inside">
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('timeline.selectSourceInterval', '选择线路区段')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <Stack spacing="4">
                            <HStack align="start" flexWrap="wrap">
                                <FormControl flex="1" minW="160px">
                                    <FormLabel>
                                        {t(`header.lineInfo.${isLoop ? 'referenceStation' : 'pathStart'}`)}
                                    </FormLabel>
                                    <Select
                                        value={from}
                                        onChange={event => {
                                            setFrom(event.target.value);
                                            if (event.target.value === to)
                                                setTo(
                                                    topology.startCandidates.find(id => id !== event.target.value) || ''
                                                );
                                            setRouteIndex(0);
                                            setSelection(undefined);
                                        }}
                                    >
                                        {topology.startCandidates.map(id => (
                                            <option key={id} value={id}>
                                                {getStationLabel(graph, id)}
                                            </option>
                                        ))}
                                    </Select>
                                </FormControl>
                                {!isLoop && (
                                    <FormControl flex="1" minW="160px">
                                        <FormLabel>{t('header.lineInfo.pathEnd')}</FormLabel>
                                        <Select
                                            value={to}
                                            onChange={event => {
                                                setTo(event.target.value);
                                                setRouteIndex(0);
                                                setSelection(undefined);
                                            }}
                                        >
                                            {topology.startCandidates
                                                .filter(id => id !== from)
                                                .map(id => (
                                                    <option key={id} value={id}>
                                                        {getStationLabel(graph, id)}
                                                    </option>
                                                ))}
                                        </Select>
                                    </FormControl>
                                )}
                                {routes.length > 1 && (
                                    <FormControl flex="1" minW="160px">
                                        <FormLabel>{t('header.lineInfo.path')}</FormLabel>
                                        <Button
                                            size="md"
                                            w="full"
                                            h="32px"
                                            fontWeight="normal"
                                            px="3"
                                            textAlign="left"
                                            justifyContent="space-between"
                                            aria-label={t('header.lineInfo.pickPath')}
                                            onClick={() => setIsPathPickerOpen(true)}
                                        >
                                            <Text isTruncated>
                                                {route.stationIds.map(id => getStationLabel(graph, id)).join('—')}
                                            </Text>
                                            <MdChevronRight />
                                        </Button>
                                    </FormControl>
                                )}
                            </HStack>
                            {topology.type === 'BRANCH' && <Text fontSize="sm">{t('header.lineInfo.branchHelp')}</Text>}
                            {route && diagram ? (
                                <Box overflowX="auto" borderWidth="1px" borderRadius="md">
                                    <svg
                                        ref={svgRef}
                                        width={width}
                                        height={diagram.height}
                                        viewBox={`0 0 ${width} ${diagram.height}`}
                                        aria-label={t('header.lineInfo.intervalDiagram')}
                                        style={{ display: 'block' }}
                                    >
                                        {diagram.branches.map(branch => (
                                            <path
                                                key={branch.key}
                                                d={branch.path}
                                                fill="none"
                                                stroke={topology.theme[2]}
                                                strokeWidth="4"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                opacity="0.5"
                                            />
                                        ))}
                                        <line
                                            x1={INTERVAL_PADDING}
                                            x2={INTERVAL_PADDING + last * INTERVAL_STATION_GAP}
                                            y1={INTERVAL_ROUTE_Y}
                                            y2={INTERVAL_ROUTE_Y}
                                            stroke={topology.theme[2]}
                                            strokeWidth="5"
                                            opacity="0.3"
                                        />
                                        <line
                                            x1={INTERVAL_PADDING + start * INTERVAL_STATION_GAP}
                                            x2={INTERVAL_PADDING + end * INTERVAL_STATION_GAP}
                                            y1={INTERVAL_ROUTE_Y}
                                            y2={INTERVAL_ROUTE_Y}
                                            stroke={topology.theme[2]}
                                            strokeWidth="6"
                                        />
                                        {diagram.junctions.map(point => (
                                            <g key={point.id} transform={`translate(${point.x},${point.y})`}>
                                                {!point.id.startsWith('stn_') && (
                                                    <circle r="4" fill={topology.theme[2]} />
                                                )}
                                                <text x="20" y="-18" fontSize="11" fill="currentColor">
                                                    {t('header.lineInfo.junction')}
                                                </text>
                                            </g>
                                        ))}
                                        {diagram.stations.map(point => (
                                            <g key={point.key} transform={`translate(${point.x},${point.y})`}>
                                                <circle r="8" fill="white" stroke={topology.theme[2]} strokeWidth="3" />
                                                <text
                                                    transform="translate(12,38) rotate(25)"
                                                    fontSize="12"
                                                    fill="currentColor"
                                                >
                                                    <title>{getStationLabel(graph, point.stationId)}</title>
                                                    {getStationLabel(graph, point.stationId)}
                                                </text>
                                            </g>
                                        ))}
                                        {handleRing('start', start, '#3182ce')}
                                        {handleRing('end', end, '#dd6b20')}
                                    </svg>
                                </Box>
                            ) : (
                                <Text>{t('header.lineInfo.noPath')}</Text>
                            )}
                            {isLoop && (
                                <Button
                                    alignSelf="start"
                                    size="sm"
                                    onClick={swapArc}
                                    isDisabled={!route || route.stationIds[start] === route.stationIds[end]}
                                >
                                    {t('header.lineInfo.otherArc')}
                                </Button>
                            )}
                            {route && (
                                <Text>
                                    {t('header.lineInfo.selection')}: {getStationLabel(graph, route.stationIds[start])}{' '}
                                    — {getStationLabel(graph, route.stationIds[end])}
                                </Text>
                            )}
                        </Stack>
                    </ModalBody>
                    <ModalFooter gap="2">
                        <Button variant="outline" onClick={onClose}>
                            {t('cancel')}
                        </Button>
                        <Button
                            colorScheme="blue"
                            isDisabled={!route}
                            onClick={() => {
                                if (route) onApply(route, start, end);
                            }}
                        >
                            {t('confirm')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
            {pathPicker}
        </>
    );
};

export default function TimelineEditorPanel({ isOpen, onClose, zIndex }: TimelineEditorPanelProps) {
    const { t } = useTranslation();
    const dispatch = useRootDispatch();
    const graph = React.useRef(window.graph);
    const { groups, lines, actionRows, validationUndoPending, unsavedDate } = useRootSelector(state => state.timeline);
    const graphRefresh = useRootSelector(state => state.runtime.refresh);

    const latestActionRowsRef = React.useRef(actionRows);
    latestActionRowsRef.current = actionRows;

    const selected = useRootSelector(state => state.runtime.selected);
    const { enableActionDateFormatValidation } = useRootSelector(state => state.app.preference);
    const toast = useToast();

    // ===== 线路编辑状态 =====
    const [editingGroup, setEditingGroup] = React.useState<LineGroup | null>(null);

    // 新建线路状态
    const [newGroupName, setNewGroupName] = React.useState('');
    const [newGroupColor, setNewGroupColor] = React.useState('#E3002B');

    // 元素编辑视图 - 当前展开查看元素的线路段ID
    const [editingElementsForLineId, setEditingElementsForLineId] = React.useState<string | null>(null);

    // 添加元素到线路段的选取状态
    const [pickingForLineId, setPickingForLineId] = React.useState<string | null>(null);
    const [pickingInsertIndex, setPickingInsertIndex] = React.useState<number | null>(null);
    const [addElementModal, setAddElementModal] = React.useState<{ lineId: string; index: number } | null>(null);
    const elementListRef = React.useRef<HTMLDivElement | null>(null);
    const pendingScrollIndexRef = React.useRef<number | null>(null);

    // 整段元素添加状态机
    const [segmentPickState, setSegmentPickState] = React.useState<
        | { step: 'idle' }
        | { step: 'pickingStartNode'; lineId: string }
        | { step: 'pickingTheme'; lineId: string; startNode: NodeId; themes: Theme[] }
        | { step: 'pickingEndNode'; lineId: string; startNode: NodeId; theme: Theme }
    >({ step: 'idle' });

    // 从已有线路段复制区间的状态
    const [addFromLineState, setAddFromLineState] = React.useState<
        | { step: 'idle' }
        | { step: 'selectLine'; groupId: string }
        | { step: 'selectInterval'; groupId: string; sourceLineId: string }
    >({ step: 'idle' });
    // 「从线路设置添加线路段」期间缓存导出图与线路导出，
    // 避免渲染（尤其是拖拽选择环每 ~30ms 触发的重渲染）反复全量 export/拓扑计算
    const exportedGraphForAdd = React.useMemo(
        () => (addFromLineState.step === 'idle' ? null : graph.current.export()),
        [addFromLineState.step, graphRefresh.nodes, graphRefresh.edges]
    );
    const lineExportsForAdd = React.useMemo(
        () => (exportedGraphForAdd ? getLineExports(exportedGraphForAdd) : []),
        [exportedGraphForAdd]
    );
    // 元素列表视图中编辑线路段名称的草稿（失焦/回车时提交，避免每次按键 dispatch）
    const [segmentNameDraft, setSegmentNameDraft] = React.useState('');

    // 动作行编辑状态
    const [editingActionRow, setEditingActionRow] = React.useState<ActionRow | null>(null);
    const [expandedPanel, setExpandedPanel] = React.useState<'lineSettings' | 'lineSegments' | 'actions' | null>(
        'lineSegments'
    );
    const [lineInfoSearch, setLineInfoSearch] = React.useState('');

    const togglePanel = (panel: 'lineSettings' | 'lineSegments' | 'actions') => {
        setExpandedPanel(current => (current === panel ? null : panel));
    };

    // 新建动作状态
    const [newActionRemark, setNewActionRemark] = React.useState('');
    const [newActionType, setNewActionType] = React.useState<ActionRow['actionType']>('open');
    const [newActionLineSegmentId, setNewActionLineSegmentId] = React.useState('');
    const [newActionDuration, setNewActionDuration] = React.useState('2');
    const [newNodeAnimationDuration, setNewNodeAnimationDuration] = React.useState('1');
    const [newActionWithPrevious, setNewActionWithPrevious] = React.useState(false);
    const [newActionQuickComplete, setNewActionQuickComplete] = React.useState(false);
    const [newUseSuggestedDuration, setNewUseSuggestedDuration] = React.useState(true);
    const [closeNodeStylesModal, setCloseNodeStylesModal] = React.useState<ActionRow | null>(null);
    const [draftCloseNodeStyles, setDraftCloseNodeStyles] = React.useState<Record<NodeId, CloseNodeStyle>>({});
    const [actionRowBeforeEditing, setActionRowBeforeEditing] = React.useState<ActionRow | null>(null);
    const [closeNodeStylesBeforeEditing, setCloseNodeStylesBeforeEditing] = React.useState<
        Record<NodeId, CloseNodeStyle>
    >({});
    const [discardChangesTarget, setDiscardChangesTarget] = React.useState<'action' | 'closeStyle' | null>(null);
    const cancelDiscardRef = React.useRef<HTMLButtonElement>(null);

    const getFocusTargetRow = React.useCallback(
        (index: number) =>
            actionRows
                .slice(index + 1)
                .find(row => (row.actionType === 'open' || row.actionType === 'close') && row.actionLineId),
        [actionRows]
    );

    const getMinimumActionDuration = (
        type: ActionRow['actionType'],
        lineId?: string,
        nodeAnimationDuration = 1
    ): number => {
        if (type !== 'open' && type !== 'close') return 0;
        const line = lineId ? lines.find(item => item.id === lineId) : undefined;
        return getActionLineMinimumDuration(line, nodeAnimationDuration);
    };

    const getSuggestedActionDuration = (lineId?: string, nodeAnimationDuration = 1): string =>
        getActionLineSuggestedDuration(
            lineId ? lines.find(line => line.id === lineId) : undefined,
            Math.max(0.1, nodeAnimationDuration)
        ).toString();

    React.useEffect(() => {
        if (newUseSuggestedDuration && (newActionType === 'open' || newActionType === 'close')) {
            setNewActionDuration(
                getSuggestedActionDuration(newActionLineSegmentId, parseFloat(newNodeAnimationDuration) || 1)
            );
        }
    }, [newUseSuggestedDuration, newActionType, newActionLineSegmentId, newNodeAnimationDuration, graphRefresh, lines]);

    React.useEffect(() => {
        if (!editingActionRow?.useSuggestedDuration) return;
        if (editingActionRow.actionType !== 'open' && editingActionRow.actionType !== 'close') return;
        const suggested = getSuggestedActionDuration(
            editingActionRow.actionLineId,
            editingActionRow.nodeAnimationDuration ?? 1
        );
        if (Number(editingActionRow.actionDuration) !== Number(suggested)) {
            setEditingActionRow(prev => (prev ? { ...prev, actionDuration: Number(suggested) } : null));
        }
    }, [
        editingActionRow?.useSuggestedDuration,
        editingActionRow?.actionType,
        editingActionRow?.actionLineId,
        editingActionRow?.nodeAnimationDuration,
        graphRefresh,
        lines,
    ]);

    const getSegmentOperationAllowed = (type: 'open' | 'close', lineId: string, beforeIndex = actionRows.length) => {
        if (!lineId) return false;
        let isOpen = false;
        for (const row of actionRows.slice(0, beforeIndex)) {
            if (row.actionLineId !== lineId) continue;
            if (row.actionType === 'open') isOpen = true;
            if (row.actionType === 'close') isOpen = false;
        }
        return type === 'open' ? !isOpen : isOpen;
    };

    // ref 捕获未保存的新动作日期，供校验 useEffect 读取
    const latestNewActionDateRef = React.useRef(unsavedDate);
    latestNewActionDateRef.current = unsavedDate;

    // 非法日期修正模态框状态
    const [invalidDateModalOpen, setInvalidDateModalOpen] = React.useState(false);
    const [invalidDateEntries, setInvalidDateEntries] = React.useState<
        Array<{ id?: string; date: string; context: string }>
    >([]);

    // 线路段选择模态框
    const [segmentModalOpen, setSegmentModalOpen] = React.useState(false);
    const [segmentModalTarget, setSegmentModalTarget] = React.useState<'new' | string>('new');
    const [segmentModalExpandedGroup, setSegmentModalExpandedGroup] = React.useState<string | null>(null);

    // 多线路选择模态框 (选择线路组)

    // 元素编辑视图内的二次确认对话框（仅清空全部）
    const [elementConfirm, setElementConfirm] = React.useState<{
        type: 'clearElements';
        lineId: string;
    } | null>(null);
    const [versionPicker, setVersionPicker] = React.useState<
        | {
              type: 'element';
              lineId: string;
              elementIndex: number;
              nodeId: NodeId;
              selectedVersion: number;
          }
        | { type: 'closeStyle'; nodeId: NodeId; selectedVersion: number }
        | null
    >(null);
    const [previewVersion, setPreviewVersion] = React.useState<{
        name: string;
        nodeId: NodeId;
        version: number;
    } | null>(null);
    const [previewScale, setPreviewScale] = React.useState(1);
    const [previewPan, setPreviewPan] = React.useState({ x: 0, y: 0 });
    const [previewViewBox, setPreviewViewBox] = React.useState('-180 -100 360 200');
    const previewDragRef = React.useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
    const previewPointersRef = React.useRef(new Map<number, { x: number; y: number }>());
    const previewPinchRef = React.useRef<{ distance: number; scale: number } | null>(null);
    const previewSvgRef = React.useCallback((svg: SVGSVGElement | null) => {
        if (!svg) return;
        requestAnimationFrame(() => {
            const viewBox = fitSvgViewBox(svg);
            if (viewBox) setPreviewViewBox(viewBox);
        });
    }, []);

    React.useEffect(() => {
        if (previewVersion) {
            setPreviewScale(1);
            setPreviewPan({ x: 0, y: 0 });
            setPreviewViewBox('-180 -100 360 200');
        }
        previewPointersRef.current.clear();
        previewPinchRef.current = null;
    }, [previewVersion]);

    const bgColor = useColorModeValue('white', 'gray.800');
    const rowBgColor = useColorModeValue('gray.50', 'gray.700');
    const toggleBg = useColorModeValue('rgb(44, 122, 123)', 'rgb(72, 187, 120)');

    // 统一的"开关按钮"样式：魔杖图标 + 文本，外层只有一层框，选中时主题绿填充
    const renderToggleSwitch = (checked: boolean, onChange: (v: boolean) => void, label: string) => (
        <Box
            as="button"
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            display="inline-flex"
            alignItems="center"
            gap={1.5}
            px={2}
            py={1}
            borderRadius="md"
            borderWidth={1}
            borderStyle="solid"
            borderColor={checked ? toggleBg : 'gray.300'}
            bg={checked ? toggleBg : 'transparent'}
            color={checked ? 'white' : 'gray.600'}
            fontSize="xs"
            fontWeight={checked ? 'semibold' : 'normal'}
            cursor="pointer"
            _hover={{
                borderColor: checked ? toggleBg : 'gray.400',
                bg: checked ? toggleBg : 'gray.50',
            }}
            _focusVisible={{ outline: '2px solid', outlineColor: toggleBg, outlineOffset: 1 }}
            onClick={() => onChange(!checked)}
        >
            <MdAutoFixHigh size="13px" />
            <span style={{ lineHeight: 1.3, whiteSpace: 'nowrap' }}>{label}</span>
        </Box>
    );

    // ===== 辅助函数：获取线路段所属的线路 =====
    const getGroupForSegment = (lineId: string): LineGroup | undefined => {
        const seg = lines.find(l => l.id === lineId);
        if (!seg) return undefined;
        return groups.find(g => g.id === seg.groupId);
    };

    // ===== 非法日期 =====
    const handleModalClearOne = (id: string | undefined) => {
        if (id === undefined) {
            dispatch(clearUnsavedDraft());
        } else {
            dispatch(updateActionRow({ id, updates: { date: '' } }));
        }
    };

    const handleModalClearAll = () => {
        const savedIds = invalidDateEntries.filter(e => e.id !== undefined).map(e => e.id as string);
        const hasUnsaved = invalidDateEntries.some(e => e.id === undefined);
        if (savedIds.length > 0) {
            dispatch(batchClearActionRowDates(savedIds));
        }
        if (hasUnsaved) {
            dispatch(clearUnsavedDraft());
        }
        setInvalidDateModalOpen(false);
    };

    const handleModalFix = (id: string | undefined, newDate: string) => {
        if (id === undefined) {
            dispatch(setUnsavedDate(newDate));
        } else {
            dispatch(updateActionRow({ id, updates: { date: newDate } }));
        }
    };

    const handleModalIgnore = () => {
        setInvalidDateModalOpen(false);
    };

    // 撤销/恢复发生后切换校验开关状态
    React.useEffect(() => {
        if (validationUndoPending) {
            dispatch(setEnableActionDateFormatValidation(!enableActionDateFormatValidation));
            dispatch(clearValidationUndoPending());
        }
    }, [validationUndoPending, dispatch, enableActionDateFormatValidation]);

    // 监听选取元素（单元素添加）
    const prevSelectedRef = React.useRef(selected);
    React.useEffect(() => {
        if (selected === prevSelectedRef.current) return;

        const [firstId] = selected;
        if (!firstId) return;

        if (pickingForLineId) {
            // 单元素添加模式
            prevSelectedRef.current = selected;

            const line = lines.find(l => l.id === pickingForLineId);
            if (!line) return;

            if (line.elements.some(e => e.id === firstId)) {
                setPickingForLineId(null);
                dispatch(clearSelected());
                return;
            }

            const defaultVersion = graph.current.hasNode(firstId)
                ? (graph.current.getNodeAttribute(firstId, 'currentVersion') ?? 1)
                : 1;
            const newElement: LineElement = {
                id: firstId as Id,
                ...(defaultVersion > 1 ? { version: defaultVersion } : {}),
            };
            const insertAt = pickingInsertIndex === null ? line.elements.length : pickingInsertIndex;
            const newElements = [...line.elements];
            newElements.splice(insertAt, 0, newElement);
            pendingScrollIndexRef.current = insertAt;
            dispatch(updateTimelineLine({ id: pickingForLineId, updates: { elements: newElements } }));
            setPickingForLineId(null);
            setPickingInsertIndex(null);
            dispatch(clearSelected());
        } else if (segmentPickState.step === 'pickingStartNode') {
            // 整段添加 - 选择起点
            const id = firstId as string;
            if (!id.startsWith('stn_') && !id.startsWith('misc_node_')) return;
            prevSelectedRef.current = selected;

            const startNode = resolveVirtualNodeToStation(graph.current, firstId as NodeId);
            const themes = findThemesAtNode(graph.current, startNode);
            if (themes.length === 0) {
                // 没有主题，直接作为单个节点添加
                const currentLine = lines.find(l => l.id === segmentPickState.lineId);
                const existing = [...(currentLine?.elements ?? [])];
                const insertAt = pickingInsertIndex === null ? existing.length : pickingInsertIndex;
                existing.splice(insertAt, 0, { id: startNode as Id });
                pendingScrollIndexRef.current = insertAt;
                dispatch(
                    updateTimelineLine({
                        id: segmentPickState.lineId,
                        updates: { elements: existing },
                    })
                );
                setPickingInsertIndex(null);
                setSegmentPickState({ step: 'idle' });
            } else {
                setSegmentPickState({ step: 'pickingTheme', lineId: segmentPickState.lineId, startNode, themes });
            }
            dispatch(clearSelected());
        } else if (segmentPickState.step === 'pickingEndNode') {
            // 整段添加 - 选择终点
            const id = firstId as string;
            if (!id.startsWith('stn_') && !id.startsWith('misc_node_')) return;
            prevSelectedRef.current = selected;

            const endNode = resolveVirtualNodeToStation(graph.current, firstId as NodeId);
            const { lineId, startNode, theme } = segmentPickState;
            const path = findPathByTheme(graph.current, startNode, endNode, theme);
            if (path) {
                const entries = calculateAutoReverseForPath(graph.current, path);
                const newElements: LineElement[] = entries.map(e => {
                    const defaultVersion = graph.current.hasNode(e.id)
                        ? (graph.current.getNodeAttribute(e.id, 'currentVersion') ?? 1)
                        : 1;
                    return {
                        id: e.id,
                        reverse: e.reverse || undefined,
                        ...(defaultVersion > 1 ? { version: defaultVersion } : {}),
                    };
                });
                const currentLine = lines.find(l => l.id === lineId);
                const existing = [...(currentLine?.elements ?? [])];
                const insertAt = pickingInsertIndex === null ? existing.length : pickingInsertIndex;
                existing.splice(insertAt, 0, ...newElements);
                pendingScrollIndexRef.current = insertAt;
                dispatch(updateTimelineLine({ id: lineId, updates: { elements: existing } }));
            }
            setPickingInsertIndex(null);
            setSegmentPickState({ step: 'idle' });
            dispatch(clearSelected());
        }
    }, [selected, pickingForLineId, pickingInsertIndex, segmentPickState, lines, dispatch]);

    // 日期格式全局校验
    const prevValidationRef = React.useRef(enableActionDateFormatValidation);
    React.useEffect(() => {
        const justTurnedOn = !prevValidationRef.current && enableActionDateFormatValidation;
        prevValidationRef.current = enableActionDateFormatValidation;

        if (!justTurnedOn) return;

        const currentActionRows = latestActionRowsRef.current;
        const savedInvalidRows = currentActionRows.filter(row => row.date && !isValidDateFormat(row.date));

        const unsavedDate = latestNewActionDateRef.current;
        const hasUnsavedInvalid = unsavedDate && !isValidDateFormat(unsavedDate);

        const entries: Array<{ id?: string; date: string; context: string }> = [];
        savedInvalidRows.forEach((row, idx) => {
            const rowIndex = currentActionRows.findIndex(r => r.id === row.id);
            entries.push({
                id: row.id,
                date: row.date,
                context: `${t('timeline.action', '动作')} #${rowIndex + 1} (${row.actionType})`,
            });
        });
        if (hasUnsavedInvalid) {
            entries.push({
                id: undefined,
                date: unsavedDate,
                context: `${t('timeline.action', '新动作输入框')}（${t('timeline.action.unsaved', '未保存')}）`,
            });
        }

        if (entries.length === 0) return;

        setInvalidDateEntries(entries);
        setInvalidDateModalOpen(true);
    }, [enableActionDateFormatValidation, t, dispatch]);

    // ===== 线路 CRUD =====
    const handleAddGroup = () => {
        dispatch(
            addLineGroup({
                bgColor: newGroupColor,
                text: newGroupName.trim() || t('timeline.newLine', '新线路'),
            })
        );
        setNewGroupName('');
        setNewGroupColor('#E3002B');
    };

    const handleUpdateGroup = () => {
        if (editingGroup) {
            dispatch(updateLineGroup({ id: editingGroup.id, updates: editingGroup }));
            setEditingGroup(null);
        }
    };

    const handleRemoveGroup = (id: string) => {
        dispatch(removeLineGroup(id));
        if (editingGroup?.id === id) setEditingGroup(null);
    };

    // ===== 线路段 CRUD =====
    const handleAddSegment = (groupId: string) => {
        dispatch(
            addTimelineLine({
                groupId,
                text: t('timeline.newSegment', '新线路段'),
                elements: [],
            })
        );
    };

    const handleSelectSourceLine = (groupId: string, sourceLineId: string) => {
        // 可选线路来自 lineExportsForAdd，能渲染成按钮即有效，无需再全量计算一次
        setAddFromLineState({ step: 'selectInterval', groupId, sourceLineId });
    };

    const handleCreateSegmentFromInterval = (route: LineRoute, start: number, end: number) => {
        if (addFromLineState.step !== 'selectInterval') return;
        const sourceEntry = lineExportsForAdd.find(entry => entry.line.id === addFromLineState.sourceLineId);
        if (!sourceEntry || sourceEntry.error) return;
        if (start < 0 || end >= route.stationIds.length || start >= end) return;
        const path: string[] = [route.nodeIds[0]];
        for (let index = 1; index < route.nodeIds.length; index += 1) {
            const from = route.nodeIds[index - 1];
            const to = route.nodeIds[index];
            const edgeId = route.segments.flat().find(id => {
                if (!graph.current.hasEdge(id)) return false;
                const [a, b] = graph.current.extremities(id);
                return (a === from && b === to) || (a === to && b === from);
            });
            if (!edgeId) continue;
            path.push(edgeId, to);
        }
        const fullElements = calculateAutoReverseForPath(graph.current, path as Id[]).map(element => ({
            id: element.id,
            ...(element.reverse ? { reverse: true } : {}),
        }));
        const stationIndexes = fullElements
            .map((element, index) => (element.id.startsWith('stn_') ? index : -1))
            .filter(index => index >= 0);
        const elements = fullElements.slice(stationIndexes[start], stationIndexes[end] + 1);
        const stationNames = route.stationIds
            .slice(start, end + 1)
            .map(id => getNodeDisplayName(graph.current, id as NodeId).trim())
            .filter(Boolean);
        const firstStationName = stationNames[0] ?? '';
        const lastStationName = stationNames[stationNames.length - 1] ?? '';
        const sourceName = sourceEntry.line.name[0].trim();
        const text =
            firstStationName && lastStationName
                ? sourceName
                    ? `${sourceName}（${firstStationName}-${lastStationName}）`
                    : `${firstStationName}-${lastStationName}`
                : t('timeline.newSegment', '新线路段');
        dispatch(addTimelineLine({ groupId: addFromLineState.groupId, text, elements }));
        setAddFromLineState({ step: 'idle' });
    };

    const handleRemoveSegment = (id: string) => {
        dispatch(removeTimelineLine(id));
        if (editingElementsForLineId === id) setEditingElementsForLineId(null);
    };

    const handleStartEditElements = (lineId: string) => {
        setEditingElementsForLineId(lineId);
        setEditingGroup(null);
    };

    const handleBackFromElements = () => {
        setEditingElementsForLineId(null);
    };

    // 提交线路段名称（失焦/回车），空值回退为默认名
    const commitSegmentName = () => {
        if (!editingLineData) return;
        const trimmed = segmentNameDraft.trim();
        const finalText = trimmed || t('timeline.newSegment', '新线路段');
        if (finalText !== editingLineData.text) {
            dispatch(updateTimelineLine({ id: editingLineData.id, updates: { text: finalText } }));
        }
        setSegmentNameDraft(finalText);
    };

    // ===== 元素列表操作 =====
    const handleStartPickElement = (lineId: string, insertIndex?: number) => {
        setPickingForLineId(lineId);
        setPickingInsertIndex(insertIndex ?? null);
    };

    const handleCancelPickElement = () => {
        setPickingForLineId(null);
        setPickingInsertIndex(null);
        dispatch(clearSelected());
    };

    const handleCancelSegmentPick = () => {
        setPickingInsertIndex(null);
        setSegmentPickState({ step: 'idle' });
        dispatch(clearSelected());
    };

    const handleStartSegmentPick = (lineId: string, insertIndex?: number) => {
        setPickingInsertIndex(insertIndex ?? null);
        setSegmentPickState({ step: 'pickingStartNode', lineId });
    };

    React.useEffect(() => {
        const insertIndex = pendingScrollIndexRef.current;
        if (insertIndex === null) return;
        pendingScrollIndexRef.current = null;
        requestAnimationFrame(() => {
            const container = elementListRef.current;
            const row = container?.children.item(insertIndex) as HTMLElement | null;
            if (!container || !row) return;
            const containerRect = container.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            const isInViewport = rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom;
            if (!isInViewport) {
                row.scrollIntoView({ block: 'end', behavior: 'smooth' });
            }
        });
    }, [editingElementsForLineId, lines]);

    const handleRemoveElement = (lineId: string, elementIndex: number) => {
        const line = lines.find(l => l.id === lineId);
        if (!line) return;
        const newElements = line.elements.filter((_, i) => i !== elementIndex);
        dispatch(updateTimelineLine({ id: lineId, updates: { elements: newElements } }));
    };

    const handleToggleElementReverse = (lineId: string, elementIndex: number) => {
        const line = lines.find(l => l.id === lineId);
        if (!line) return;
        const isEdge = line.elements[elementIndex].id.startsWith('line_');
        if (!isEdge) return;
        const newElements = line.elements.map((el, i) => (i === elementIndex ? { ...el, reverse: !el.reverse } : el));
        dispatch(updateTimelineLine({ id: lineId, updates: { elements: newElements } }));
    };

    const handleToggleElementSimultaneous = (lineId: string, elementIndex: number) => {
        const line = lines.find(l => l.id === lineId);
        if (!line || elementIndex === 0) return;
        const newElements = line.elements.map((el, i) =>
            i === elementIndex ? { ...el, simultaneous: !el.simultaneous } : el
        );
        dispatch(updateTimelineLine({ id: lineId, updates: { elements: newElements } }));
    };

    const handleSetElementVersion = (lineId: string, elementIndex: number, version: number) => {
        const line = lines.find(l => l.id === lineId);
        if (!line) return;
        const newElements = line.elements.map((el, i) => {
            if (i !== elementIndex) return el;
            if (version <= 1) {
                const { version: _, ...rest } = el;
                return rest;
            }
            return { ...el, version };
        });
        dispatch(updateTimelineLine({ id: lineId, updates: { elements: newElements } }));
    };

    const handleMoveElement = (lineId: string, fromIndex: number, toIndex: number) => {
        const line = lines.find(l => l.id === lineId);
        if (!line || fromIndex === toIndex) return;
        const newElements = [...line.elements];
        const [removed] = newElements.splice(fromIndex, 1);
        newElements.splice(toIndex, 0, removed);
        dispatch(updateTimelineLine({ id: lineId, updates: { elements: newElements } }));
    };

    const handleReverseAllElements = (lineId: string) => {
        const line = lines.find(l => l.id === lineId);
        if (!line) return;
        const newElements = line.elements
            .map(el => (el.id.startsWith('line_') ? { ...el, reverse: !el.reverse } : el))
            .reverse();
        dispatch(updateTimelineLine({ id: lineId, updates: { elements: newElements } }));
    };

    // ===== 元素操作二次确认 =====
    const handleRequestElementConfirm = (lineId: string) => {
        setElementConfirm({ type: 'clearElements', lineId });
    };

    const handleExecuteElementConfirm = () => {
        if (!elementConfirm) return;
        dispatch(updateTimelineLine({ id: elementConfirm.lineId, updates: { elements: [] } }));
        setElementConfirm(null);
    };

    const getNodeVersionOptions = (nodeId: NodeId): number[] => {
        if (!graph.current.hasNode(nodeId)) return [1];
        const versions = graph.current.getNodeAttribute(nodeId, 'versions') ?? [];
        return Array.from(new Set([1, ...versions.map(v => v.version)])).sort((a, b) => a - b);
    };

    const getNodeVersionName = (nodeId: NodeId, version: number): string => {
        if (version === 1) return 'basic';
        const stored = graph.current.getNodeAttribute(nodeId, 'versions')?.find(v => v.version === version);
        return stored?.name || `v${version}`;
    };

    const getCloseStyleNodes = (lineId?: string): NodeId[] => {
        const line = lineId ? lines.find(item => item.id === lineId) : undefined;
        if (!line) return [];
        return line.elements
            .filter(element => {
                if (!element.id.startsWith('stn_') && !element.id.startsWith('misc_node_')) return false;
                return getNodeVersionOptions(element.id as NodeId).length > 1;
            })
            .map(element => element.id as NodeId);
    };

    const openCloseNodeStylesModal = (row: ActionRow) => {
        const styles: Record<NodeId, CloseNodeStyle> = {};
        getCloseStyleNodes(row.actionLineId).forEach(nodeId => {
            styles[nodeId] = row.closeNodeStyles?.[nodeId] ?? { visible: false, version: 1 };
        });
        setDraftCloseNodeStyles(styles);
        setCloseNodeStylesBeforeEditing(styles);
        setCloseNodeStylesModal(row);
    };

    const requestCloseActionEditor = () => {
        if (
            editingActionRow &&
            actionRowBeforeEditing &&
            JSON.stringify(editingActionRow) !== JSON.stringify(actionRowBeforeEditing)
        ) {
            setDiscardChangesTarget('action');
            return;
        }
        setEditingActionRow(null);
        setActionRowBeforeEditing(null);
    };

    const requestCloseNodeStylesModal = () => {
        if (JSON.stringify(draftCloseNodeStyles) !== JSON.stringify(closeNodeStylesBeforeEditing)) {
            setDiscardChangesTarget('closeStyle');
            return;
        }
        setCloseNodeStylesModal(null);
        setCloseNodeStylesBeforeEditing({});
    };

    const getElementDisplayName = (el: LineElement): string => {
        if (el.id.startsWith('line_')) {
            if (graph.current.hasEdge(el.id)) {
                const [source, target] = graph.current.extremities(el.id);
                const srcName = getNodeDisplayName(graph.current, source as NodeId);
                const tgtName = getNodeDisplayName(graph.current, target as NodeId);
                return el.reverse ? `${tgtName} → ${srcName}` : `${srcName} → ${tgtName}`;
            }
            return el.id;
        }
        return getNodeDisplayName(graph.current, el.id as NodeId);
    };

    // ===== 线路段选择模态框 =====
    const handleOpenSegmentModal = (targetType: 'new' | string, currentSegmentId: string) => {
        setSegmentModalTarget(targetType);
        setSegmentModalExpandedGroup(null);
        setSegmentModalOpen(true);
    };

    const getSegmentActionRemark = (segmentId: string, actionType: 'open' | 'close'): string => {
        const segment = lines.find(line => line.id === segmentId);
        const group = segment ? groups.find(item => item.id === segment.groupId) : undefined;
        if (!segment || !group) return '';

        let endpointText = '';
        const stationNodes = segment.elements
            .map(element => element.id as NodeId)
            .filter(nodeId => {
                if (!graph.current.hasNode(nodeId)) return false;
                const attributes = graph.current.getNodeAttributes(nodeId);
                return attributes.isStation ?? nodeId.startsWith('stn_');
            });
        const firstNode = stationNodes[0];
        const lastNode = stationNodes[stationNodes.length - 1];
        const getNamedStation = (nodeId: NodeId | undefined): string => {
            if (!nodeId || !graph.current.hasNode(nodeId)) return '';
            const attributes = graph.current.getNodeAttributes(nodeId);
            const station = graph.current.getNodeAttribute(nodeId, attributes.type) as
                | { names?: unknown[] }
                | undefined;
            const name = station?.names?.find(value => typeof value === 'string' && value.trim());
            return typeof name === 'string' ? name.trim() : '';
        };
        const firstName = getNamedStation(firstNode);
        const lastName = getNamedStation(lastNode);
        if (firstName && lastName) endpointText = `(${firstName}-${lastName})`;

        return `${group.text}${endpointText}${actionType === 'open' ? '开通运营' : '停止对外服务'}`;
    };

    const handleSelectSegment = (segmentId: string) => {
        if (segmentModalTarget === 'new') {
            setNewActionLineSegmentId(segmentId);
            setNewActionDuration(getSuggestedActionDuration(segmentId, parseFloat(newNodeAnimationDuration) || 1));
            if (newActionType === 'open' || newActionType === 'close') {
                setNewActionRemark(getSegmentActionRemark(segmentId, newActionType));
            }
        } else if (editingActionRow && segmentModalTarget === editingActionRow.id) {
            setEditingActionRow(prev =>
                prev
                    ? {
                          ...prev,
                          actionLineId: segmentId || undefined,
                          remark:
                              prev.actionType === 'open' || prev.actionType === 'close'
                                  ? getSegmentActionRemark(segmentId, prev.actionType)
                                  : prev.remark,
                      }
                    : null
            );
        }
        setSegmentModalOpen(false);
    };

    // ===== 动作行 CRUD =====
    const handleAddActionRow = () => {
        if (
            (newActionType === 'open' || newActionType === 'close') &&
            enableActionDateFormatValidation &&
            unsavedDate &&
            !isValidDateFormat(unsavedDate)
        ) {
            toast({
                title: t('error'),
                description: t(
                    'timeline.action.invalidDateFormat',
                    '日期格式无效，请输入 YYYY-MM-DD，或在设置中关闭动作日期格式校验'
                ),
                status: 'error',
                duration: 5000,
                isClosable: true,
                position: 'bottom-right',
            });
            dispatch(setUnsavedDate(''));
            return;
        }

        const isMetaAction = newActionType === 'overview' || newActionType === 'wait' || newActionType === 'focus';
        const shouldAddFocus = newActionType === 'open' || newActionType === 'close';
        if (shouldAddFocus && !getSegmentOperationAllowed(newActionType, newActionLineSegmentId)) {
            toast({
                title: t('error'),
                description:
                    newActionType === 'open' ? '该线路段当前已经开通，不能重复开通' : '该线路段当前未开通，不能停运',
                status: 'error',
                duration: 5000,
                isClosable: true,
                position: 'bottom-right',
            });
            return;
        }
        if (shouldAddFocus && !newActionQuickComplete) {
            const minimumDuration = getMinimumActionDuration(newActionType, newActionLineSegmentId);
            const duration = parseFloat(newActionDuration);
            if (!Number.isFinite(duration) || duration < minimumDuration) {
                toast({
                    title: t('error'),
                    description: `开通/停运动作时长不得小于 ${minimumDuration.toFixed(1)} 秒`,
                    status: 'error',
                    duration: 5000,
                    isClosable: true,
                    position: 'bottom-right',
                });
                return;
            }
        }
        const constraintState = getActionConstraintState(actionRows, actionRows.length);
        if (shouldAddFocus && constraintState.canAddFocus && !newActionWithPrevious) {
            dispatch(addActionRow({ date: '', activeLineIds: [], remark: '', actionType: 'focus', actionDuration: 4 }));
        }
        dispatch(
            addActionRow({
                // 并行动作的日期与备注继承批次首动作；目标线路段各自独立选择
                date: isMetaAction ? '' : (newActionAnchorRow?.date ?? (unsavedDate || '')),
                activeLineIds: [],
                remark: isMetaAction ? '' : (newActionAnchorRow?.remark ?? (newActionRemark || '')),
                actionType: newActionType,
                actionLineId:
                    newActionType === 'open' || newActionType === 'close'
                        ? newActionLineSegmentId || undefined
                        : undefined,
                actionDuration:
                    newActionType === 'overview' || newActionType === 'focus'
                        ? 4
                        : newActionQuickComplete
                          ? 1
                          : parseFloat(newActionDuration) || undefined,
                nodeAnimationDuration:
                    newActionType === 'open' || newActionType === 'close'
                        ? Math.max(0.1, parseFloat(newNodeAnimationDuration) || 1)
                        : undefined,
                withPrevious: actionRows.length > 0 ? newActionWithPrevious : undefined,
                quickComplete:
                    newActionType === 'open' || newActionType === 'close' ? newActionQuickComplete : undefined,
                // 仅开通/停运且非快速完成时保存建议时长开关
                useSuggestedDuration:
                    (newActionType === 'open' || newActionType === 'close') && !newActionQuickComplete
                        ? newUseSuggestedDuration
                        : undefined,
            })
        );
        dispatch(setUnsavedDate(''));
        setNewActionRemark('');
        setNewActionLineSegmentId('');
        setNewActionDuration(getSuggestedActionDuration());
        setNewNodeAnimationDuration('1');
        setNewActionWithPrevious(false);
        setNewActionQuickComplete(false);
        setNewUseSuggestedDuration(false);
    };

    const handleAddActionRowBelow = (index: number) => {
        // 在指定动作下方添加一个新动作，预填原动作的类型
        const sourceRow = actionRows[index];
        if (!sourceRow) return;
        const constraintState = getActionConstraintState(actionRows, index + 1);
        if (sourceRow.actionType === 'focus' && !constraintState.canAddFocus) return;
        // 全览行：若全览后尚未执行聚焦（互斥规则允许插入聚焦），则"在下方添加"
        // 直接插入聚焦动作 —— 修复"中间插入聚焦的限制问题"：此时复制全览会被
        // canAddOverview 拦截（全览后未聚焦禁止再加全览），用户无法在中间插入聚焦。
        if (sourceRow.actionType === 'overview' && constraintState.canAddFocus) {
            dispatch(addActionRow({ date: '', activeLineIds: [], remark: '', actionType: 'focus', actionDuration: 4 }));
            const newIndex = actionRows.length;
            if (newIndex > index + 1) dispatch(reorderActionRows({ fromIndex: newIndex - 1, toIndex: index + 1 }));
            return;
        }
        if (sourceRow.actionType === 'overview' && !constraintState.canAddOverview) return;
        // 直接 dispatch 添加
        dispatch(
            addActionRow({
                date: '',
                activeLineIds: [],
                remark: '',
                actionType: sourceRow.actionType,
                actionLineId: sourceRow.actionLineId,
                actionDuration: sourceRow.actionType === 'wait' ? 2 : undefined,
                withPrevious: sourceRow.withPrevious,
                quickComplete:
                    sourceRow.actionType === 'open' || sourceRow.actionType === 'close'
                        ? sourceRow.quickComplete
                        : undefined,
            })
        );
        // 移动新行到目标位置下方
        const newIndex = actionRows.length;
        if (newIndex > index + 1) dispatch(reorderActionRows({ fromIndex: newIndex - 1, toIndex: index + 1 }));
    };

    const handleUpdateActionRow = () => {
        if (editingActionRow) {
            if (
                (editingActionRow.actionType === 'open' || editingActionRow.actionType === 'close') &&
                !getSegmentOperationAllowed(
                    editingActionRow.actionType,
                    editingActionRow.actionLineId ?? '',
                    actionRows.findIndex(row => row.id === editingActionRow.id)
                )
            ) {
                toast({
                    title: t('error'),
                    description: '该线路段的开通/停运顺序不合法',
                    status: 'error',
                    duration: 5000,
                    isClosable: true,
                    position: 'bottom-right',
                });
                return;
            }
            const minimumDuration = getMinimumActionDuration(
                editingActionRow.actionType,
                editingActionRow.actionLineId,
                editingActionRow.nodeAnimationDuration ?? 1
            );
            const quickComplete = isQuickCompleteAction(editingActionRow);
            if (
                !quickComplete &&
                (editingActionRow.actionType === 'open' || editingActionRow.actionType === 'close') &&
                (!Number.isFinite(editingActionRow.actionDuration) ||
                    (editingActionRow.actionDuration ?? 0) < minimumDuration)
            ) {
                toast({
                    title: t('error'),
                    description: `开通/停运动作时长不得小于 ${minimumDuration.toFixed(1)} 秒`,
                    status: 'error',
                    duration: 5000,
                    isClosable: true,
                    position: 'bottom-right',
                });
                return;
            }
            if (
                enableActionDateFormatValidation &&
                editingActionRow.date &&
                !isValidDateFormat(editingActionRow.date)
            ) {
                toast({
                    title: t('error'),
                    description: t(
                        'timeline.action.invalidDateFormat',
                        '日期格式无效，请输入 YYYY-MM-DD，或在设置中关闭动作日期格式校验'
                    ),
                    status: 'error',
                    duration: 5000,
                    isClosable: true,
                    position: 'bottom-right',
                });
                setEditingActionRow(prev => (prev ? { ...prev, date: '' } : null));
                return;
            }

            const isMetaAction =
                editingActionRow.actionType === 'overview' ||
                editingActionRow.actionType === 'wait' ||
                editingActionRow.actionType === 'focus';
            dispatch(
                updateActionRow({
                    id: editingActionRow.id,
                    updates: {
                        ...editingActionRow,
                        // 并行动作的日期与备注继承批次首动作；目标线路段各自独立
                        date: isMetaAction ? '' : (editingAnchorRow?.date ?? editingActionRow.date),
                        activeLineIds: [],
                        remark: isMetaAction ? '' : (editingAnchorRow?.remark ?? editingActionRow.remark),
                        actionLineId: isMetaAction ? undefined : editingActionRow.actionLineId,
                        withPrevious:
                            actionRows.findIndex(row => row.id === editingActionRow.id) === 0
                                ? undefined
                                : editingActionRow.withPrevious,
                        quickComplete:
                            editingActionRow.actionType === 'open' || editingActionRow.actionType === 'close'
                                ? isQuickCompleteAction(editingActionRow)
                                : undefined,
                        // 仅开通/停运且非快速完成时保留建议时长开关，其余情况清除
                        useSuggestedDuration:
                            (editingActionRow.actionType === 'open' || editingActionRow.actionType === 'close') &&
                            !isQuickCompleteAction(editingActionRow)
                                ? editingActionRow.useSuggestedDuration
                                : undefined,
                        actionDuration:
                            editingActionRow.actionType === 'overview' || editingActionRow.actionType === 'focus'
                                ? 4
                                : editingActionRow.quickComplete &&
                                    (editingActionRow.actionType === 'open' || editingActionRow.actionType === 'close')
                                  ? 1
                                  : editingActionRow.actionDuration,
                    },
                })
            );
            setEditingActionRow(null);
            setActionRowBeforeEditing(null);
        }
    };

    const handleRemoveActionRow = (id: string) => {
        dispatch(removeActionRow(id));
        if (editingActionRow?.id === id) setEditingActionRow(null);
    };

    const moveActionRow = (index: number, offset: -1 | 1) => {
        const targetIndex = index + offset;
        if (targetIndex < 0 || targetIndex >= actionRows.length) return;
        dispatch(reorderActionRows({ fromIndex: index, toIndex: targetIndex }));
    };

    const moveElement = (lineId: string, index: number, offset: -1 | 1) => {
        const line = lines.find(item => item.id === lineId);
        if (!line) return;
        const targetIndex = index + offset;
        if (targetIndex < 0 || targetIndex >= line.elements.length) return;
        handleMoveElement(lineId, index, targetIndex);
    };

    // 元素列表排序
    const [dragElementIndex, setDragElementIndex] = React.useState<number | null>(null);
    const [dragActionIndex, setDragActionIndex] = React.useState<number | null>(null);

    const editingLineData = editingElementsForLineId ? lines.find(l => l.id === editingElementsForLineId) : null;

    // 进入元素列表视图或段名被外部修改时，同步名称草稿
    React.useEffect(() => {
        setSegmentNameDraft(editingLineData?.text ?? '');
    }, [editingElementsForLineId, editingLineData?.text]);

    React.useEffect(() => {
        if (!editingElementsForLineId) return;
        const line = lines.find(item => item.id === editingElementsForLineId);
        if (!line) return;
        const existingIds = new Set(
            line.elements
                .filter(element => graph.current.hasNode(element.id) || graph.current.hasEdge(element.id))
                .map(element => element.id)
        );
        if (existingIds.size === line.elements.length) return;
        dispatch(
            updateTimelineLine({
                id: line.id,
                updates: { elements: line.elements.filter(element => existingIds.has(element.id)) },
            })
        );
    }, [dispatch, editingElementsForLineId, graphRefresh.nodes, graphRefresh.edges, lines]);

    // 获取线路段所属的线路信息（用于徽章继承）
    const getBadgeInfo = (row: ActionRow): { color: string; text: string } => {
        if (row.actionLineId) {
            const group = getGroupForSegment(row.actionLineId);
            if (group) {
                return { color: group.bgColor, text: group.text };
            }
        }
        return { color: '#E3002B', text: '' };
    };

    // 新建动作开启"与上一动作同时"时，继承的批次首动作（线路徽章/备注/已开通线路均以它为准）
    const newActionAnchorRow =
        newActionWithPrevious && actionRows.length > 0
            ? actionRows[getBatchAnchorIndex(actionRows, actionRows.length - 1)]
            : undefined;
    // 编辑中的并行动作所继承的批次首动作（以草稿中的 withPrevious 为准，
    // 即用户刚在模态框勾选"与上一动作同时"也能立即看到继承效果）
    const editingAnchorRow = (() => {
        if (!editingActionRow?.withPrevious) return undefined;
        const rowIndex = actionRows.findIndex(row => row.id === editingActionRow.id);
        if (rowIndex <= 0) return undefined;
        const virtualRows = [...actionRows];
        virtualRows[rowIndex] = { ...virtualRows[rowIndex], withPrevious: true };
        return virtualRows[getBatchAnchorIndex(virtualRows, rowIndex)];
    })();

    const isMetaAction = newActionType === 'overview' || newActionType === 'wait' || newActionType === 'focus';

    return (
        <RmgSidePanel isOpen={isOpen} width={380} header="" alwaysOverlay sx={{ zIndex: zIndex ?? 10 }}>
            <RmgSidePanelHeader onClose={onClose}>
                <Flex align="center" flex={1}>
                    <Text flex={1}>{t('timeline.editor.title', '动画时间线')}</Text>
                </Flex>
            </RmgSidePanelHeader>
            <Box overflow="hidden" flex="1" minH={0} display="flex" flexDirection="column">
                <RmgSidePanelBody>
                    <VStack spacing={3} align="stretch" minH={0}>
                        {/* 选取状态提示 - 单元素添加 */}
                        {pickingForLineId && (
                            <Box p={2} bg="blue.50" borderRadius="md">
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="blue.600">
                                        {t('timeline.pickElement', '请在画布上点击要添加的元素')}
                                    </Text>
                                    <Button size="xs" variant="outline" onClick={handleCancelPickElement}>
                                        {t('cancel', '取消')}
                                    </Button>
                                </HStack>
                            </Box>
                        )}

                        {/* 选取状态提示 - 整段添加 */}
                        {segmentPickState.step === 'pickingStartNode' && (
                            <Box p={2} bg="green.50" borderRadius="md">
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="green.600">
                                        {t('timeline.pickStartNode', '请在画布上点击路径起点')}
                                    </Text>
                                    <Button size="xs" variant="outline" onClick={handleCancelSegmentPick}>
                                        {t('cancel', '取消')}
                                    </Button>
                                </HStack>
                            </Box>
                        )}
                        {segmentPickState.step === 'pickingEndNode' && (
                            <Box p={2} bg="green.50" borderRadius="md">
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="green.600">
                                        {t('timeline.pickEndNode', '请在画布上点击路径终点')}
                                    </Text>
                                    <Button size="xs" variant="outline" onClick={handleCancelSegmentPick}>
                                        {t('cancel', '取消')}
                                    </Button>
                                </HStack>
                            </Box>
                        )}

                        {/* ===== 上半区域：线路列表（一级）→ 线路段列表（二级） ===== */}
                        <Box
                            borderTop="1px solid"
                            borderColor="gray.200"
                            pt={2}
                            flex={editingElementsForLineId || expandedPanel !== 'lineSegments' ? 1 : undefined}
                            display={editingElementsForLineId || expandedPanel !== 'lineSegments' ? 'flex' : undefined}
                            flexDirection={
                                editingElementsForLineId || expandedPanel !== 'lineSegments' ? 'column' : undefined
                            }
                            order={2}
                        >
                            <Flex
                                justify="space-between"
                                align="center"
                                mb={2}
                                minH="40px"
                                px={2}
                                borderRadius="md"
                                cursor="pointer"
                                _hover={{ bg: 'gray.100' }}
                                onClick={() => togglePanel('lineSegments')}
                            >
                                <Text as="b" fontSize="sm">
                                    {editingElementsForLineId
                                        ? t('timeline.elements', '线路段元素')
                                        : t('timeline.lineSegments', '线路段设置')}
                                </Text>
                                <IconButton
                                    size="sm"
                                    variant="ghost"
                                    icon={
                                        expandedPanel !== 'lineSegments' ? (
                                            <MdChevronRight size="1.5em" />
                                        ) : (
                                            <MdChevronLeft size="1.5em" />
                                        )
                                    }
                                    aria-label={
                                        expandedPanel !== 'lineSegments'
                                            ? t('timeline.expandLines', '展开线路段设置')
                                            : t('timeline.collapseLines', '折叠线路段设置')
                                    }
                                />
                            </Flex>
                            <Collapse in={expandedPanel === 'lineSegments'} animateOpacity>
                                {editingElementsForLineId && editingLineData ? (
                                    /* 元素列表编辑视图 */
                                    <VStack spacing={2} align="stretch" height="100%" minH={0}>
                                        <HStack>
                                            <IconButton
                                                size="xs"
                                                variant="ghost"
                                                icon={<MdArrowBack />}
                                                aria-label={t('back', '返回')}
                                                onClick={handleBackFromElements}
                                            />
                                            <Text fontSize="sm" fontWeight="bold" whiteSpace="nowrap">
                                                {(() => {
                                                    const g = getGroupForSegment(editingLineData.id);
                                                    return g ? g.text : editingLineData.id;
                                                })()}
                                                {' - '}
                                            </Text>
                                            <Input
                                                size="xs"
                                                flex={1}
                                                minWidth={0}
                                                value={segmentNameDraft}
                                                onChange={e => setSegmentNameDraft(e.target.value)}
                                                onBlur={commitSegmentName}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        (e.target as HTMLInputElement).blur();
                                                    } else if (e.key === 'Escape') {
                                                        setSegmentNameDraft(editingLineData.text);
                                                        (e.target as HTMLInputElement).blur();
                                                    }
                                                }}
                                                placeholder={t('timeline.segmentName', '线路段名称')}
                                                aria-label={t('timeline.segmentName', '线路段名称')}
                                            />
                                            <Text fontSize="xs" color="gray.500" whiteSpace="nowrap">
                                                ({editingLineData.elements.length})
                                            </Text>
                                        </HStack>

                                        <HStack>
                                            <Button
                                                size="xs"
                                                leftIcon={<MdAdd />}
                                                onClick={() => handleStartPickElement(editingLineData.id)}
                                            >
                                                {t('timeline.addElement', '添加元素')}
                                            </Button>
                                            <Button
                                                size="xs"
                                                colorScheme="teal"
                                                variant="outline"
                                                leftIcon={<MdAdd />}
                                                onClick={() => handleStartSegmentPick(editingLineData.id)}
                                            >
                                                {t('timeline.addSegmentPath', '整段添加')}
                                            </Button>
                                            {editingLineData.elements.some(e => e.id.startsWith('line_')) && (
                                                <Button
                                                    size="xs"
                                                    variant="outline"
                                                    leftIcon={<MdSwapHoriz />}
                                                    bg="white"
                                                    color="orange.500"
                                                    borderColor="orange.500"
                                                    _hover={{
                                                        bg: 'white',
                                                        color: 'orange.500',
                                                        borderColor: 'orange.500',
                                                    }}
                                                    _active={{
                                                        bg: 'white',
                                                        color: 'orange.500',
                                                        borderColor: 'orange.500',
                                                    }}
                                                    onClick={() => handleReverseAllElements(editingLineData.id)}
                                                >
                                                    {t('timeline.reverseAll', '全部反转')}
                                                </Button>
                                            )}
                                        </HStack>

                                        <VStack
                                            ref={elementListRef}
                                            spacing={1}
                                            align="stretch"
                                            maxH="calc(100dvh - 300px)"
                                            overflowY="auto"
                                            overflowX="hidden"
                                        >
                                            {editingLineData.elements.map((el, index) => {
                                                const isNode =
                                                    el.id.startsWith('stn_') || el.id.startsWith('misc_node_');
                                                const versionOptions = isNode
                                                    ? getNodeVersionOptions(el.id as NodeId)
                                                    : [];
                                                const showVersionSelector = versionOptions.length > 1;

                                                return (
                                                    <Box
                                                        key={`${el.id}-${index}`}
                                                        p={1}
                                                        bg={rowBgColor}
                                                        borderRadius="sm"
                                                        borderWidth="1px"
                                                        borderColor={
                                                            dragElementIndex === index ? 'blue.300' : 'transparent'
                                                        }
                                                        draggable
                                                        onDragStart={() => setDragElementIndex(index)}
                                                        onDragOver={e => {
                                                            e.preventDefault();
                                                            if (
                                                                dragElementIndex !== null &&
                                                                dragElementIndex !== index
                                                            ) {
                                                                handleMoveElement(
                                                                    editingLineData.id,
                                                                    dragElementIndex,
                                                                    index
                                                                );
                                                                setDragElementIndex(index);
                                                            }
                                                        }}
                                                        onDragEnd={() => setDragElementIndex(null)}
                                                        cursor="grab"
                                                    >
                                                        <HStack spacing={1}>
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<MdArrowUpward />}
                                                                aria-label={t('timeline.moveUp', '上移')}
                                                                isDisabled={index === 0}
                                                                onClick={event => {
                                                                    event.stopPropagation();
                                                                    moveElement(editingLineData.id, index, -1);
                                                                }}
                                                            />
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<MdArrowDownward />}
                                                                aria-label={t('timeline.moveDown', '下移')}
                                                                isDisabled={
                                                                    index === editingLineData.elements.length - 1
                                                                }
                                                                onClick={event => {
                                                                    event.stopPropagation();
                                                                    moveElement(editingLineData.id, index, 1);
                                                                }}
                                                            />
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<MdAdd />}
                                                                aria-label={t('timeline.addBelow', '在下方添加')}
                                                                onClick={event => {
                                                                    event.stopPropagation();
                                                                    setAddElementModal({
                                                                        lineId: editingLineData.id,
                                                                        index: index + 1,
                                                                    });
                                                                }}
                                                            />
                                                            <Badge colorScheme={isNode ? 'teal' : 'gray'} fontSize="xs">
                                                                {isNode ? 'N' : 'L'}
                                                            </Badge>
                                                            <Text
                                                                fontSize="xs"
                                                                flex={1}
                                                                minWidth={0}
                                                                noOfLines={1}
                                                                wordBreak="break-all"
                                                                cursor="pointer"
                                                                color="blue.600"
                                                                _hover={{ textDecoration: 'underline' }}
                                                                onClick={event => {
                                                                    event.stopPropagation();
                                                                    dispatch(setSelected(new Set<Id>([el.id])));
                                                                }}
                                                            >
                                                                {getElementDisplayName(el)}
                                                            </Text>
                                                            {el.id.startsWith('line_') && (
                                                                <Button
                                                                    size="xs"
                                                                    variant="outline"
                                                                    leftIcon={<MdSwapHoriz />}
                                                                    bg="white"
                                                                    color="orange.500"
                                                                    borderColor="orange.500"
                                                                    _hover={{
                                                                        bg: 'white',
                                                                        color: 'orange.500',
                                                                        borderColor: 'orange.500',
                                                                    }}
                                                                    _active={{
                                                                        bg: 'white',
                                                                        color: 'orange.500',
                                                                        borderColor: 'orange.500',
                                                                    }}
                                                                    onClick={event => {
                                                                        event.stopPropagation();
                                                                        handleToggleElementReverse(
                                                                            editingLineData.id,
                                                                            index
                                                                        );
                                                                    }}
                                                                >
                                                                    {t('timeline.reverse', '反转')}
                                                                </Button>
                                                            )}
                                                            {showVersionSelector && (
                                                                <Button
                                                                    size="xs"
                                                                    variant="outline"
                                                                    width="96px"
                                                                    justifyContent="space-between"
                                                                    rightIcon={<MdExpandMore />}
                                                                    onClick={() =>
                                                                        setVersionPicker({
                                                                            type: 'element',
                                                                            lineId: editingLineData.id,
                                                                            elementIndex: index,
                                                                            nodeId: el.id as NodeId,
                                                                            selectedVersion: el.version ?? 1,
                                                                        })
                                                                    }
                                                                >
                                                                    <Text noOfLines={1} flex={1} textAlign="left">
                                                                        {getNodeVersionName(
                                                                            el.id as NodeId,
                                                                            el.version ?? 1
                                                                        )}
                                                                    </Text>
                                                                </Button>
                                                            )}
                                                            <Button
                                                                size="xs"
                                                                variant="outline"
                                                                leftIcon={<MdSchedule />}
                                                                bg={el.simultaneous ? 'blue.600' : 'white'}
                                                                color={el.simultaneous ? 'white' : 'blue.600'}
                                                                borderColor="blue.600"
                                                                isDisabled={index === 0}
                                                                _hover={{
                                                                    bg: el.simultaneous ? 'blue.600' : 'white',
                                                                    color: el.simultaneous ? 'white' : 'blue.600',
                                                                    borderColor: 'blue.600',
                                                                }}
                                                                _active={{
                                                                    bg: el.simultaneous ? 'blue.600' : 'white',
                                                                    color: el.simultaneous ? 'white' : 'blue.600',
                                                                    borderColor: 'blue.600',
                                                                }}
                                                                onClick={event => {
                                                                    event.stopPropagation();
                                                                    handleToggleElementSimultaneous(
                                                                        editingLineData.id,
                                                                        index
                                                                    );
                                                                }}
                                                            >
                                                                {t('timeline.simultaneous', '同时')}
                                                            </Button>
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                colorScheme="red"
                                                                icon={<MdDelete />}
                                                                aria-label={t('remove', '删除')}
                                                                onClick={() =>
                                                                    handleRemoveElement(editingLineData.id, index)
                                                                }
                                                            />
                                                        </HStack>
                                                    </Box>
                                                );
                                            })}
                                            {editingLineData.elements.length === 0 && (
                                                <Text fontSize="xs" color="gray.400" textAlign="center" py={2}>
                                                    {t('timeline.noElements', '暂无元素，请点击"添加元素"')}
                                                </Text>
                                            )}
                                        </VStack>

                                        {editingLineData.elements.length > 0 && (
                                            <Button
                                                size="xs"
                                                colorScheme="red"
                                                variant="outline"
                                                leftIcon={<MdDelete />}
                                                width="full"
                                                onClick={() => handleRequestElementConfirm(editingLineData.id)}
                                            >
                                                {t('timeline.clearAllElements', '一键删除全部元素')}
                                            </Button>
                                        )}
                                    </VStack>
                                ) : (
                                    /* 线路列表视图 */
                                    <>
                                        <Flex justify="space-between" align="center" mb={2}>
                                            <Text as="b" fontSize="sm">
                                                {t('timeline.lineSegments', '线路段设置')}
                                            </Text>
                                        </Flex>

                                        {/* 添加线路 */}
                                        <VStack spacing={1} p={2} bg={rowBgColor} borderRadius="md" mb={2}>
                                            <Input
                                                size="xs"
                                                value={newGroupName}
                                                onChange={e => setNewGroupName(e.target.value)}
                                                placeholder={t('timeline.line.name', '线路名称')}
                                            />
                                            <HStack spacing={2} width="100%">
                                                <Text fontSize="xs">{t('timeline.line.color', '颜色')}:</Text>
                                                <TimelineColorPicker
                                                    hexColor={newGroupColor}
                                                    onChange={setNewGroupColor}
                                                />
                                                <Button
                                                    size="xs"
                                                    leftIcon={<MdAdd />}
                                                    onClick={handleAddGroup}
                                                    flex={1}
                                                >
                                                    {t('timeline.addLine', '添加线路')}
                                                </Button>
                                            </HStack>
                                        </VStack>

                                        {/* 线路列表 */}
                                        <VStack spacing={1} align="stretch" overflow="visible">
                                            {groups.map(group => {
                                                const groupSegments = lines.filter(l => l.groupId === group.id);
                                                const isEditingGroup = editingGroup?.id === group.id;

                                                return (
                                                    <Box key={group.id} p={2} bg={rowBgColor} borderRadius="md">
                                                        {isEditingGroup ? (
                                                            <VStack spacing={1}>
                                                                <Input
                                                                    size="xs"
                                                                    value={editingGroup.text}
                                                                    onChange={e =>
                                                                        setEditingGroup(prev =>
                                                                            prev
                                                                                ? { ...prev, text: e.target.value }
                                                                                : null
                                                                        )
                                                                    }
                                                                    placeholder={t('timeline.line.name', '线路名称')}
                                                                />
                                                                <HStack spacing={2}>
                                                                    <Text fontSize="xs">
                                                                        {t('timeline.line.color', '颜色')}:
                                                                    </Text>
                                                                    <TimelineColorPicker
                                                                        hexColor={editingGroup.bgColor}
                                                                        onChange={color =>
                                                                            setEditingGroup(prev =>
                                                                                prev
                                                                                    ? { ...prev, bgColor: color }
                                                                                    : null
                                                                            )
                                                                        }
                                                                    />
                                                                </HStack>
                                                                <HStack>
                                                                    <Button size="xs" onClick={handleUpdateGroup}>
                                                                        {t('confirm', '确定')}
                                                                    </Button>
                                                                    <Button
                                                                        size="xs"
                                                                        variant="outline"
                                                                        onClick={() => setEditingGroup(null)}
                                                                    >
                                                                        {t('cancel', '取消')}
                                                                    </Button>
                                                                </HStack>
                                                            </VStack>
                                                        ) : (
                                                            <>
                                                                {/* 线路头 */}
                                                                <Flex justify="space-between" align="center" mb={1}>
                                                                    <HStack spacing={2} flex={1} minWidth={0}>
                                                                        <Badge
                                                                            bg={group.bgColor}
                                                                            color="white"
                                                                            fontSize="xs"
                                                                            px={1}
                                                                            borderRadius="sm"
                                                                        >
                                                                            {group.text}
                                                                        </Badge>
                                                                        <Text fontSize="xs" color="gray.500">
                                                                            {groupSegments.length}{' '}
                                                                            {t('timeline.segments', '段')}
                                                                        </Text>
                                                                    </HStack>
                                                                    <HStack spacing={1}>
                                                                        <IconButton
                                                                            size="xs"
                                                                            variant="ghost"
                                                                            icon={<MdEdit />}
                                                                            aria-label={t('edit', '编辑')}
                                                                            onClick={() => setEditingGroup(group)}
                                                                        />
                                                                        <IconButton
                                                                            size="xs"
                                                                            variant="ghost"
                                                                            colorScheme="red"
                                                                            icon={<MdDelete />}
                                                                            aria-label={t('remove', '删除')}
                                                                            onClick={() => handleRemoveGroup(group.id)}
                                                                        />
                                                                    </HStack>
                                                                </Flex>

                                                                {/* 线路段列表 */}
                                                                <VStack spacing={1} align="stretch" pl={4} mt={1}>
                                                                    {groupSegments.map(seg => (
                                                                        <Box key={seg.id}>
                                                                            <Flex
                                                                                justify="space-between"
                                                                                align="center"
                                                                                p={1}
                                                                                bg={bgColor}
                                                                                borderRadius="sm"
                                                                            >
                                                                                <HStack
                                                                                    spacing={1}
                                                                                    flex={1}
                                                                                    minWidth={0}
                                                                                >
                                                                                    <Text
                                                                                        fontSize="xs"
                                                                                        flex={1}
                                                                                        minWidth={0}
                                                                                        noOfLines={1}
                                                                                        wordBreak="break-all"
                                                                                    >
                                                                                        {seg.text}
                                                                                    </Text>
                                                                                    <Badge
                                                                                        fontSize="xs"
                                                                                        variant="outline"
                                                                                        flexShrink={0}
                                                                                    >
                                                                                        {seg.elements?.length ?? 0}
                                                                                    </Badge>
                                                                                </HStack>
                                                                                <HStack spacing={0}>
                                                                                    <IconButton
                                                                                        size="xs"
                                                                                        variant="ghost"
                                                                                        icon={<MdEdit />}
                                                                                        aria-label={t(
                                                                                            'timeline.modify',
                                                                                            '修改'
                                                                                        )}
                                                                                        onClick={() =>
                                                                                            handleStartEditElements(
                                                                                                seg.id
                                                                                            )
                                                                                        }
                                                                                    />
                                                                                    <IconButton
                                                                                        size="xs"
                                                                                        variant="ghost"
                                                                                        colorScheme="red"
                                                                                        icon={<MdDelete />}
                                                                                        aria-label={t('remove', '删除')}
                                                                                        onClick={() =>
                                                                                            handleRemoveSegment(seg.id)
                                                                                        }
                                                                                    />
                                                                                </HStack>
                                                                            </Flex>
                                                                        </Box>
                                                                    ))}

                                                                    {/* 添加线路段 */}
                                                                    <HStack spacing={1} align="stretch">
                                                                        <Button
                                                                            flex={1}
                                                                            size="xs"
                                                                            variant="outline"
                                                                            leftIcon={<MdAdd />}
                                                                            iconSpacing={1}
                                                                            h="auto"
                                                                            minH="24px"
                                                                            py={1}
                                                                            whiteSpace="normal"
                                                                            wordBreak="break-all"
                                                                            lineHeight="1.2"
                                                                            fontSize="11px"
                                                                            onClick={() => handleAddSegment(group.id)}
                                                                        >
                                                                            {t(
                                                                                'timeline.newBlankSegment',
                                                                                '新建空白线路段'
                                                                            )}
                                                                        </Button>
                                                                        <Button
                                                                            flex={1}
                                                                            size="xs"
                                                                            variant="outline"
                                                                            leftIcon={<MdAdd />}
                                                                            iconSpacing={1}
                                                                            h="auto"
                                                                            minH="24px"
                                                                            py={1}
                                                                            whiteSpace="normal"
                                                                            wordBreak="break-all"
                                                                            lineHeight="1.2"
                                                                            fontSize="11px"
                                                                            onClick={() =>
                                                                                setAddFromLineState({
                                                                                    step: 'selectLine',
                                                                                    groupId: group.id,
                                                                                })
                                                                            }
                                                                        >
                                                                            {t(
                                                                                'timeline.addFromLineSettings',
                                                                                '从线路设置中添加线路段'
                                                                            )}
                                                                        </Button>
                                                                    </HStack>
                                                                </VStack>
                                                            </>
                                                        )}
                                                    </Box>
                                                );
                                            })}
                                            {groups.length === 0 && (
                                                <Text fontSize="xs" color="gray.400" textAlign="center" py={2}>
                                                    {t('timeline.noGroups', '暂无线路，请在上方添加')}
                                                </Text>
                                            )}
                                        </VStack>
                                    </>
                                )}
                            </Collapse>
                        </Box>

                        {/* ===== 线路设置 ===== */}
                        {!editingElementsForLineId && (
                            <Box borderTop="1px solid" borderColor="gray.200" pt={2} order={1}>
                                <Flex
                                    justify="space-between"
                                    align="center"
                                    mb={2}
                                    minH="40px"
                                    px={2}
                                    borderRadius="md"
                                    cursor="pointer"
                                    _hover={{ bg: 'gray.100' }}
                                    onClick={() => togglePanel('lineSettings')}
                                >
                                    <Text as="b" fontSize="md">
                                        {t('timeline.lineSettings', '线路设置')}
                                    </Text>
                                    <IconButton
                                        size="sm"
                                        variant="ghost"
                                        icon={
                                            expandedPanel !== 'lineSettings' ? (
                                                <MdChevronRight size="1.5em" />
                                            ) : (
                                                <MdChevronLeft size="1.5em" />
                                            )
                                        }
                                        aria-label={
                                            expandedPanel !== 'lineSettings'
                                                ? t('timeline.expandLineSettings', '展开线路设置')
                                                : t('timeline.collapseLineSettings', '折叠线路设置')
                                        }
                                    />
                                </Flex>
                                <Collapse in={expandedPanel === 'lineSettings'} animateOpacity>
                                    <Box p={2} overflowY="auto" maxH="100%">
                                        <Input
                                            size="sm"
                                            mb={3}
                                            value={lineInfoSearch}
                                            onChange={event => setLineInfoSearch(event.target.value)}
                                            placeholder={t('timeline.searchLines', '搜索线路')}
                                            aria-label={t('timeline.searchLines', '搜索线路')}
                                        />
                                        <LineInfoModal embedded search={lineInfoSearch} />
                                    </Box>
                                </Collapse>
                            </Box>
                        )}

                        {/* ===== 下半区域：动作列表 ===== */}
                        {!editingElementsForLineId && (
                            <Box
                                borderTop="1px solid"
                                borderColor="gray.200"
                                pt={2}
                                order={3}
                                flex={expandedPanel !== 'actions' ? 1 : undefined}
                                display={expandedPanel !== 'actions' ? 'flex' : undefined}
                                flexDirection={expandedPanel !== 'actions' ? 'column' : undefined}
                            >
                                <Flex
                                    justify="space-between"
                                    align="center"
                                    mb={2}
                                    minH="40px"
                                    px={2}
                                    borderRadius="md"
                                    cursor="pointer"
                                    _hover={{ bg: 'gray.100' }}
                                    onClick={() => togglePanel('actions')}
                                >
                                    <Text as="b" fontSize="sm">
                                        {t('timeline.actionSettings', '动作设置')}
                                    </Text>
                                    <IconButton
                                        size="sm"
                                        variant="ghost"
                                        icon={
                                            expandedPanel !== 'actions' ? (
                                                <MdChevronRight size="1.5em" />
                                            ) : (
                                                <MdChevronLeft size="1.5em" />
                                            )
                                        }
                                        aria-label={
                                            expandedPanel !== 'actions'
                                                ? t('timeline.expandActions', '展开动作设置')
                                                : t('timeline.collapseActions', '折叠动作设置')
                                        }
                                    />
                                </Flex>

                                <Collapse in={expandedPanel === 'actions'} animateOpacity>
                                    {/* 添加动作 */}
                                    <VStack spacing={1} p={2} bg={rowBgColor} borderRadius="md" mb={2}>
                                        <Input
                                            size="xs"
                                            value={newActionAnchorRow?.date ?? unsavedDate}
                                            isDisabled={
                                                newActionType === 'overview' ||
                                                newActionType === 'wait' ||
                                                newActionType === 'focus' ||
                                                Boolean(newActionAnchorRow)
                                            }
                                            onChange={e => dispatch(setUnsavedDate(e.target.value))}
                                            onBlur={() => {
                                                if (
                                                    (newActionType === 'open' || newActionType === 'close') &&
                                                    enableActionDateFormatValidation &&
                                                    unsavedDate &&
                                                    !isValidDateFormat(unsavedDate)
                                                ) {
                                                    toast({
                                                        title: t('error'),
                                                        description: t(
                                                            'timeline.action.invalidDateFormat',
                                                            '日期格式无效，请输入 YYYY-MM-DD，或在设置中关闭动作日期格式校验'
                                                        ),
                                                        status: 'error',
                                                        duration: 5000,
                                                        isClosable: true,
                                                        position: 'bottom-right',
                                                    });
                                                    dispatch(setUnsavedDate(''));
                                                }
                                            }}
                                            placeholder={
                                                newActionAnchorRow
                                                    ? t('timeline.action.dateInherited', '继承首个并行动作的日期')
                                                    : 'YYYY-MM-DD'
                                            }
                                            borderColor={
                                                enableActionDateFormatValidation &&
                                                unsavedDate &&
                                                !isValidDateFormat(unsavedDate)
                                                    ? 'red.300'
                                                    : undefined
                                            }
                                        />
                                        <HStack spacing={2} width="100%">
                                            <Text fontSize="xs">{t('timeline.action.type', '类型')}:</Text>
                                            <Select
                                                size="xs"
                                                value={newActionType}
                                                onChange={e => {
                                                    const nextType = e.target.value as ActionRow['actionType'];
                                                    const constraintState = getActionConstraintState(
                                                        actionRows,
                                                        actionRows.length - 1
                                                    );
                                                    if (nextType === 'focus' && !constraintState.canAddFocus) return;
                                                    if (nextType === 'overview' && !constraintState.canAddOverview)
                                                        return;
                                                    setNewActionType(nextType);
                                                    if (
                                                        nextType === 'overview' ||
                                                        nextType === 'wait' ||
                                                        nextType === 'focus'
                                                    ) {
                                                        dispatch(setUnsavedDate(''));
                                                    }
                                                    if (nextType === 'wait') {
                                                        setNewActionDuration('2');
                                                    } else if (nextType === 'open' || nextType === 'close') {
                                                        setNewActionDuration(
                                                            getSuggestedActionDuration(
                                                                newActionLineSegmentId,
                                                                parseFloat(newNodeAnimationDuration) || 1
                                                            )
                                                        );
                                                    }
                                                }}
                                                flex={1}
                                            >
                                                <option value="open">{t('timeline.action.open', '开通')}</option>
                                                <option value="close">{t('timeline.action.close', '停运')}</option>
                                                <option
                                                    value="overview"
                                                    disabled={
                                                        !getActionConstraintState(actionRows, actionRows.length - 1)
                                                            .canAddOverview
                                                    }
                                                >
                                                    {t('timeline.action.overview', '全览')}
                                                </option>
                                                <option value="wait">{t('timeline.action.wait', '等待')}</option>
                                                <option
                                                    value="focus"
                                                    disabled={
                                                        !getActionConstraintState(actionRows, actionRows.length - 1)
                                                            .canAddFocus
                                                    }
                                                >
                                                    {t('timeline.action.focus', '聚焦')}
                                                </option>
                                            </Select>
                                        </HStack>

                                        {/* 动态参数：开通/停运 -> 线路段选择（模态框） */}
                                        {(newActionType === 'open' || newActionType === 'close') && (
                                            <HStack spacing={2} width="100%">
                                                <Text fontSize="xs">
                                                    {t('timeline.action.lineSegment', '目标线路段')}:
                                                </Text>
                                                <Button
                                                    size="xs"
                                                    variant="outline"
                                                    onClick={() =>
                                                        handleOpenSegmentModal('new', newActionLineSegmentId)
                                                    }
                                                    flex={1}
                                                >
                                                    {newActionLineSegmentId
                                                        ? (() => {
                                                              const seg = lines.find(
                                                                  l => l.id === newActionLineSegmentId
                                                              );
                                                              const g = seg
                                                                  ? groups.find(gr => gr.id === seg.groupId)
                                                                  : undefined;
                                                              return g
                                                                  ? `${g.text} > ${seg?.text}`
                                                                  : t('timeline.action.selectSegment', '选择线路段');
                                                          })()
                                                        : t('timeline.action.selectSegment', '选择线路段')}
                                                </Button>
                                            </HStack>
                                        )}

                                        {/* 时长 */}
                                        {!newActionQuickComplete && (
                                            <HStack spacing={2} width="100%">
                                                <Text fontSize="xs">{t('timeline.action.duration', '时长')}:</Text>
                                                <Input
                                                    size="xs"
                                                    type="number"
                                                    step="0.1"
                                                    min={
                                                        newActionType === 'open' || newActionType === 'close'
                                                            ? newActionQuickComplete
                                                                ? 1
                                                                : getMinimumActionDuration(
                                                                      newActionType,
                                                                      newActionLineSegmentId,
                                                                      Math.max(
                                                                          0.1,
                                                                          parseFloat(newNodeAnimationDuration) || 1
                                                                      )
                                                                  )
                                                            : undefined
                                                    }
                                                    value={
                                                        newActionType === 'overview' || newActionType === 'focus'
                                                            ? '4'
                                                            : newActionQuickComplete
                                                              ? '1'
                                                              : newActionDuration
                                                    }
                                                    isDisabled={
                                                        newActionType === 'overview' ||
                                                        newActionType === 'focus' ||
                                                        newActionQuickComplete ||
                                                        newUseSuggestedDuration
                                                    }
                                                    onChange={e => setNewActionDuration(e.target.value)}
                                                    width="80px"
                                                />
                                                <Text fontSize="xs">{t('timeline.second', '秒')}</Text>
                                                {(newActionType === 'open' || newActionType === 'close') &&
                                                    !newActionQuickComplete &&
                                                    renderToggleSwitch(
                                                        newUseSuggestedDuration,
                                                        setNewUseSuggestedDuration,
                                                        t('timeline.useSuggestedDuration', '使用建议时长')
                                                    )}
                                            </HStack>
                                        )}

                                        {actionRows.length > 0 && (
                                            <HStack spacing={2} width="100%">
                                                <Text fontSize="xs">与上一动作同时:</Text>
                                                <Switch
                                                    size="sm"
                                                    isChecked={newActionWithPrevious}
                                                    onChange={e => setNewActionWithPrevious(e.target.checked)}
                                                />
                                            </HStack>
                                        )}

                                        {(newActionType === 'open' || newActionType === 'close') && (
                                            <HStack spacing={2} width="100%">
                                                <Text fontSize="xs">快速完成:</Text>
                                                <Switch
                                                    size="sm"
                                                    isChecked={newActionQuickComplete}
                                                    onChange={e => setNewActionQuickComplete(e.target.checked)}
                                                />
                                            </HStack>
                                        )}

                                        {(newActionType === 'open' || newActionType === 'close') &&
                                            !newActionQuickComplete && (
                                                <HStack spacing={2} width="100%">
                                                    <Text fontSize="xs">车站动画时长:</Text>
                                                    <Input
                                                        size="xs"
                                                        type="number"
                                                        step="0.1"
                                                        min={0.1}
                                                        value={newNodeAnimationDuration}
                                                        onChange={e => setNewNodeAnimationDuration(e.target.value)}
                                                        width="80px"
                                                    />
                                                    <Text fontSize="xs">秒</Text>
                                                </HStack>
                                            )}

                                        {!isMetaAction && (
                                            <Input
                                                size="xs"
                                                value={newActionAnchorRow?.remark ?? newActionRemark}
                                                isDisabled={Boolean(newActionAnchorRow)}
                                                onChange={e => setNewActionRemark(e.target.value)}
                                                placeholder={
                                                    newActionAnchorRow
                                                        ? t('timeline.action.remarkInherited', '继承首个并行动作的备注')
                                                        : t('timeline.action.remark', '备注')
                                                }
                                            />
                                        )}
                                        <Button
                                            size="xs"
                                            leftIcon={<MdAdd />}
                                            onClick={handleAddActionRow}
                                            width="100%"
                                            variant="outline"
                                        >
                                            {t('timeline.addAction', '添加动作')}
                                        </Button>
                                    </VStack>

                                    {/* 动作列表 */}
                                    <VStack
                                        spacing={1}
                                        align="stretch"
                                        maxH="calc(100dvh - 360px)"
                                        overflowY="auto"
                                        overflowX="hidden"
                                    >
                                        {actionRows.map((row, index) => {
                                            const badgeInfo = getBadgeInfo(row);

                                            return (
                                                <Box
                                                    key={row.id}
                                                    p={2}
                                                    bg={rowBgColor}
                                                    borderRadius="md"
                                                    draggable={editingActionRow?.id !== row.id}
                                                    cursor={editingActionRow?.id === row.id ? 'default' : 'grab'}
                                                    borderWidth="1px"
                                                    borderColor={dragActionIndex === index ? 'blue.300' : 'transparent'}
                                                    onDragStart={event => {
                                                        if (editingActionRow?.id === row.id) return;
                                                        event.dataTransfer.effectAllowed = 'move';
                                                        setDragActionIndex(index);
                                                    }}
                                                    onDragOver={event => {
                                                        event.preventDefault();
                                                        if (dragActionIndex !== null && dragActionIndex !== index) {
                                                            dispatch(
                                                                reorderActionRows({
                                                                    fromIndex: dragActionIndex,
                                                                    toIndex: index,
                                                                })
                                                            );
                                                            setDragActionIndex(index);
                                                        }
                                                    }}
                                                    onDragEnd={() => setDragActionIndex(null)}
                                                >
                                                    {/* 编辑弹窗通过 portal 挂载，与行内容并列渲染，避免该行在列表中消失 */}
                                                    {editingActionRow?.id === row.id && (
                                                        <Modal
                                                            isOpen
                                                            onClose={requestCloseActionEditor}
                                                            size={{ base: 'full', md: 'md' }}
                                                        >
                                                            <ModalOverlay />
                                                            <ModalContent>
                                                                <ModalHeader>编辑动作</ModalHeader>
                                                                <ModalCloseButton />
                                                                <ModalBody>
                                                                    <VStack spacing={1}>
                                                                        <Input
                                                                            size="xs"
                                                                            value={
                                                                                editingAnchorRow?.date ??
                                                                                editingActionRow.date
                                                                            }
                                                                            isDisabled={
                                                                                editingActionRow.actionType ===
                                                                                    'overview' ||
                                                                                editingActionRow.actionType ===
                                                                                    'wait' ||
                                                                                editingActionRow.actionType ===
                                                                                    'focus' ||
                                                                                Boolean(editingAnchorRow)
                                                                            }
                                                                            onChange={e =>
                                                                                setEditingActionRow(prev =>
                                                                                    prev
                                                                                        ? {
                                                                                              ...prev,
                                                                                              date: e.target.value,
                                                                                          }
                                                                                        : null
                                                                                )
                                                                            }
                                                                            onBlur={() => {
                                                                                if (
                                                                                    enableActionDateFormatValidation &&
                                                                                    editingActionRow.date &&
                                                                                    !isValidDateFormat(
                                                                                        editingActionRow.date
                                                                                    )
                                                                                ) {
                                                                                    toast({
                                                                                        title: t('error'),
                                                                                        description: t(
                                                                                            'timeline.action.invalidDateFormat',
                                                                                            '日期格式无效，请输入 YYYY-MM-DD，或在设置中关闭动作日期格式校验'
                                                                                        ),
                                                                                        status: 'error',
                                                                                        duration: 5000,
                                                                                        isClosable: true,
                                                                                        position: 'bottom-right',
                                                                                    });
                                                                                    setEditingActionRow(prev =>
                                                                                        prev
                                                                                            ? { ...prev, date: '' }
                                                                                            : null
                                                                                    );
                                                                                }
                                                                            }}
                                                                            placeholder={
                                                                                editingAnchorRow
                                                                                    ? t(
                                                                                          'timeline.action.dateInherited',
                                                                                          '继承首个并行动作的日期'
                                                                                      )
                                                                                    : 'YYYY-MM-DD'
                                                                            }
                                                                            borderColor={
                                                                                enableActionDateFormatValidation &&
                                                                                editingActionRow.date &&
                                                                                !isValidDateFormat(
                                                                                    editingActionRow.date
                                                                                )
                                                                                    ? 'red.300'
                                                                                    : undefined
                                                                            }
                                                                        />
                                                                        <Select
                                                                            size="xs"
                                                                            value={editingActionRow.actionType}
                                                                            onChange={e => {
                                                                                const nextType = e.target
                                                                                    .value as ActionRow['actionType'];
                                                                                const constraintState =
                                                                                    getActionConstraintState(
                                                                                        actionRows,
                                                                                        index
                                                                                    );
                                                                                if (
                                                                                    nextType === 'focus' &&
                                                                                    !constraintState.canAddFocus
                                                                                )
                                                                                    return;
                                                                                if (
                                                                                    nextType === 'overview' &&
                                                                                    !constraintState.canAddOverview
                                                                                )
                                                                                    return;
                                                                                setEditingActionRow(prev =>
                                                                                    prev
                                                                                        ? {
                                                                                              ...prev,
                                                                                              actionType: nextType,
                                                                                              date:
                                                                                                  nextType === 'open' ||
                                                                                                  nextType === 'close'
                                                                                                      ? prev.date
                                                                                                      : '',
                                                                                              remark:
                                                                                                  nextType === 'open' ||
                                                                                                  nextType === 'close'
                                                                                                      ? prev.remark
                                                                                                      : '',
                                                                                              activeLineIds: [],
                                                                                              actionLineId:
                                                                                                  nextType === 'open' ||
                                                                                                  nextType === 'close'
                                                                                                      ? prev.actionLineId
                                                                                                      : undefined,
                                                                                              actionDuration:
                                                                                                  nextType ===
                                                                                                      'overview' ||
                                                                                                  nextType === 'focus'
                                                                                                      ? 4
                                                                                                      : prev.actionDuration,
                                                                                          }
                                                                                        : null
                                                                                );
                                                                            }}
                                                                        >
                                                                            <option value="open">
                                                                                {t('timeline.action.open')}
                                                                            </option>
                                                                            <option value="close">
                                                                                {t('timeline.action.close')}
                                                                            </option>
                                                                            <option
                                                                                value="overview"
                                                                                disabled={
                                                                                    !getActionConstraintState(
                                                                                        actionRows,
                                                                                        index
                                                                                    ).canAddOverview
                                                                                }
                                                                            >
                                                                                {t('timeline.action.overview')}
                                                                            </option>
                                                                            <option value="wait">
                                                                                {t('timeline.action.wait')}
                                                                            </option>
                                                                            <option
                                                                                value="focus"
                                                                                disabled={
                                                                                    !getActionConstraintState(
                                                                                        actionRows,
                                                                                        index
                                                                                    ).canAddFocus
                                                                                }
                                                                            >
                                                                                {t('timeline.action.focus', '聚焦')}
                                                                            </option>
                                                                        </Select>

                                                                        {/* 开通/停运 -> 线路段选择（模态框） */}
                                                                        {(editingActionRow.actionType === 'open' ||
                                                                            editingActionRow.actionType ===
                                                                                'close') && (
                                                                            <HStack spacing={2} width="100%">
                                                                                <Text fontSize="xs">
                                                                                    {t('timeline.action.lineSegment')}:
                                                                                </Text>
                                                                                <Button
                                                                                    size="xs"
                                                                                    variant="outline"
                                                                                    onClick={() =>
                                                                                        handleOpenSegmentModal(
                                                                                            row.id,
                                                                                            editingActionRow.actionLineId ??
                                                                                                ''
                                                                                        )
                                                                                    }
                                                                                    flex={1}
                                                                                >
                                                                                    {editingActionRow.actionLineId
                                                                                        ? (() => {
                                                                                              const seg = lines.find(
                                                                                                  l =>
                                                                                                      l.id ===
                                                                                                      editingActionRow.actionLineId
                                                                                              );
                                                                                              const g = seg
                                                                                                  ? groups.find(
                                                                                                        gr =>
                                                                                                            gr.id ===
                                                                                                            seg.groupId
                                                                                                    )
                                                                                                  : undefined;
                                                                                              return g
                                                                                                  ? `${g.text} > ${seg?.text}`
                                                                                                  : t(
                                                                                                        'timeline.action.selectSegment',
                                                                                                        '选择线路段'
                                                                                                    );
                                                                                          })()
                                                                                        : t(
                                                                                              'timeline.action.selectSegment',
                                                                                              '选择线路段'
                                                                                          )}
                                                                                </Button>
                                                                            </HStack>
                                                                        )}

                                                                        {editingActionRow.actionType === 'close' && (
                                                                            <Button
                                                                                size="xs"
                                                                                variant="outline"
                                                                                width="100%"
                                                                                onClick={() =>
                                                                                    openCloseNodeStylesModal(
                                                                                        editingActionRow
                                                                                    )
                                                                                }
                                                                            >
                                                                                设置停运后换乘站样式
                                                                            </Button>
                                                                        )}

                                                                        {/* 时长编辑 */}
                                                                        {!editingActionRow.quickComplete && (
                                                                            <HStack spacing={2} width="100%">
                                                                                <Text fontSize="xs">
                                                                                    {t('timeline.action.duration')}:
                                                                                </Text>
                                                                                <Input
                                                                                    size="xs"
                                                                                    type="number"
                                                                                    step="0.1"
                                                                                    min={
                                                                                        editingActionRow.quickComplete
                                                                                            ? 1
                                                                                            : editingActionRow.actionType ===
                                                                                                    'open' ||
                                                                                                editingActionRow.actionType ===
                                                                                                    'close'
                                                                                              ? getMinimumActionDuration(
                                                                                                    editingActionRow.actionType,
                                                                                                    editingActionRow.actionLineId,
                                                                                                    editingActionRow.nodeAnimationDuration ??
                                                                                                        1
                                                                                                )
                                                                                              : undefined
                                                                                    }
                                                                                    value={
                                                                                        editingActionRow.actionType ===
                                                                                            'overview' ||
                                                                                        editingActionRow.actionType ===
                                                                                            'focus'
                                                                                            ? 4
                                                                                            : editingActionRow.quickComplete
                                                                                              ? 1
                                                                                              : (editingActionRow.actionDuration ??
                                                                                                (editingActionRow.actionType ===
                                                                                                'wait'
                                                                                                    ? 2
                                                                                                    : ''))
                                                                                    }
                                                                                    isDisabled={
                                                                                        editingActionRow.actionType ===
                                                                                            'overview' ||
                                                                                        editingActionRow.actionType ===
                                                                                            'focus' ||
                                                                                        Boolean(
                                                                                            editingActionRow.quickComplete
                                                                                        ) ||
                                                                                        Boolean(
                                                                                            editingActionRow.useSuggestedDuration
                                                                                        )
                                                                                    }
                                                                                    onChange={e =>
                                                                                        setEditingActionRow(prev =>
                                                                                            prev
                                                                                                ? {
                                                                                                      ...prev,
                                                                                                      actionDuration:
                                                                                                          Number.isFinite(
                                                                                                              Number(
                                                                                                                  e
                                                                                                                      .target
                                                                                                                      .value
                                                                                                              )
                                                                                                          )
                                                                                                              ? Number(
                                                                                                                    e
                                                                                                                        .target
                                                                                                                        .value
                                                                                                                )
                                                                                                              : undefined,
                                                                                                  }
                                                                                                : null
                                                                                        )
                                                                                    }
                                                                                    width="80px"
                                                                                />
                                                                                <Text fontSize="xs">
                                                                                    {t('timeline.second')}
                                                                                </Text>
                                                                                {(editingActionRow.actionType ===
                                                                                    'open' ||
                                                                                    editingActionRow.actionType ===
                                                                                        'close') &&
                                                                                    !editingActionRow.quickComplete &&
                                                                                    renderToggleSwitch(
                                                                                        Boolean(
                                                                                            editingActionRow.useSuggestedDuration
                                                                                        ),
                                                                                        v =>
                                                                                            setEditingActionRow(prev =>
                                                                                                prev
                                                                                                    ? {
                                                                                                          ...prev,
                                                                                                          useSuggestedDuration:
                                                                                                              v,
                                                                                                      }
                                                                                                    : null
                                                                                            ),
                                                                                        t(
                                                                                            'timeline.useSuggestedDuration',
                                                                                            '使用建议时长'
                                                                                        )
                                                                                    )}
                                                                            </HStack>
                                                                        )}

                                                                        {actionRows.findIndex(
                                                                            row => row.id === editingActionRow.id
                                                                        ) > 0 && (
                                                                            <HStack spacing={2} width="100%">
                                                                                <Text fontSize="xs">
                                                                                    与上一动作同时:
                                                                                </Text>
                                                                                <Switch
                                                                                    size="sm"
                                                                                    isChecked={Boolean(
                                                                                        editingActionRow.withPrevious
                                                                                    )}
                                                                                    onChange={e =>
                                                                                        setEditingActionRow(prev =>
                                                                                            prev
                                                                                                ? {
                                                                                                      ...prev,
                                                                                                      withPrevious:
                                                                                                          e.target
                                                                                                              .checked,
                                                                                                  }
                                                                                                : null
                                                                                        )
                                                                                    }
                                                                                />
                                                                            </HStack>
                                                                        )}

                                                                        {(editingActionRow.actionType === 'open' ||
                                                                            editingActionRow.actionType ===
                                                                                'close') && (
                                                                            <HStack spacing={2} width="100%">
                                                                                <Text fontSize="xs">快速完成:</Text>
                                                                                <Switch
                                                                                    size="sm"
                                                                                    isChecked={Boolean(
                                                                                        editingActionRow.quickComplete
                                                                                    )}
                                                                                    onChange={e =>
                                                                                        setEditingActionRow(prev =>
                                                                                            prev
                                                                                                ? {
                                                                                                      ...prev,
                                                                                                      quickComplete:
                                                                                                          e.target
                                                                                                              .checked,
                                                                                                      actionDuration: e
                                                                                                          .target
                                                                                                          .checked
                                                                                                          ? 1
                                                                                                          : prev.actionDuration,
                                                                                                  }
                                                                                                : null
                                                                                        )
                                                                                    }
                                                                                />
                                                                            </HStack>
                                                                        )}

                                                                        {(editingActionRow.actionType === 'open' ||
                                                                            editingActionRow.actionType === 'close') &&
                                                                            !editingActionRow.quickComplete && (
                                                                                <HStack spacing={2} width="100%">
                                                                                    <Text fontSize="xs">
                                                                                        车站动画时长:
                                                                                    </Text>
                                                                                    <Input
                                                                                        size="xs"
                                                                                        type="number"
                                                                                        step="0.1"
                                                                                        min={0.1}
                                                                                        value={
                                                                                            editingActionRow.nodeAnimationDuration ??
                                                                                            1
                                                                                        }
                                                                                        onChange={e =>
                                                                                            setEditingActionRow(prev =>
                                                                                                prev
                                                                                                    ? {
                                                                                                          ...prev,
                                                                                                          nodeAnimationDuration:
                                                                                                              Number(
                                                                                                                  e
                                                                                                                      .target
                                                                                                                      .value
                                                                                                              ) || 1,
                                                                                                      }
                                                                                                    : null
                                                                                            )
                                                                                        }
                                                                                        width="80px"
                                                                                    />
                                                                                    <Text fontSize="xs">秒</Text>
                                                                                </HStack>
                                                                            )}

                                                                        {(editingActionRow.actionType === 'open' ||
                                                                            editingActionRow.actionType ===
                                                                                'close') && (
                                                                            <Input
                                                                                size="xs"
                                                                                value={
                                                                                    editingAnchorRow?.remark ??
                                                                                    editingActionRow.remark
                                                                                }
                                                                                isDisabled={Boolean(editingAnchorRow)}
                                                                                onChange={e =>
                                                                                    setEditingActionRow(prev =>
                                                                                        prev
                                                                                            ? {
                                                                                                  ...prev,
                                                                                                  remark: e.target
                                                                                                      .value,
                                                                                              }
                                                                                            : null
                                                                                    )
                                                                                }
                                                                                placeholder={
                                                                                    editingAnchorRow
                                                                                        ? t(
                                                                                              'timeline.action.remarkInherited',
                                                                                              '继承首个并行动作的备注'
                                                                                          )
                                                                                        : t('timeline.action.remark')
                                                                                }
                                                                            />
                                                                        )}
                                                                    </VStack>
                                                                </ModalBody>
                                                                <ModalFooter>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        onClick={requestCloseActionEditor}
                                                                    >
                                                                        {t('cancel')}
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        colorScheme="teal"
                                                                        ml={2}
                                                                        onClick={handleUpdateActionRow}
                                                                    >
                                                                        {t('confirm')}
                                                                    </Button>
                                                                </ModalFooter>
                                                            </ModalContent>
                                                        </Modal>
                                                    )}
                                                    <Flex justify="space-between" align="center">
                                                        <HStack spacing={2} flex={1} minWidth={0}>
                                                            <Badge
                                                                bg={badgeInfo.color}
                                                                color="white"
                                                                fontSize="xs"
                                                                px={1}
                                                                borderRadius="sm"
                                                            >
                                                                {badgeInfo.text || '#' + (index + 1)}
                                                            </Badge>
                                                            <Text fontSize="xs">{row.date || '-'}</Text>
                                                            <Badge
                                                                fontSize="xs"
                                                                textTransform="none"
                                                                colorScheme={
                                                                    row.actionType === 'open'
                                                                        ? 'green'
                                                                        : row.actionType === 'close'
                                                                          ? 'red'
                                                                          : row.actionType === 'overview'
                                                                            ? 'blue'
                                                                            : row.actionType === 'focus'
                                                                              ? 'purple'
                                                                              : 'gray'
                                                                }
                                                            >
                                                                {t(`timeline.action.${row.actionType}`, row.actionType)}
                                                                {row.actionType === 'wait' &&
                                                                    ` ${Number(row.actionDuration ?? 0).toString()}s`}
                                                            </Badge>
                                                            {row.actionType === 'focus' &&
                                                                !getFocusTargetRow(index) && (
                                                                    <Text fontSize="xs" color="red.500">
                                                                        {t(
                                                                            'timeline.action.focusTargetMissing',
                                                                            '无后续目标'
                                                                        )}
                                                                    </Text>
                                                                )}
                                                            <Text fontSize="xs" color="gray.500" noOfLines={1}>
                                                                {row.remark}
                                                            </Text>
                                                        </HStack>
                                                        <HStack spacing={0}>
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<MdEdit />}
                                                                aria-label={t('edit')}
                                                                onClick={() => {
                                                                    setActionRowBeforeEditing(row);
                                                                    setEditingActionRow(row);
                                                                }}
                                                            />
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                colorScheme="red"
                                                                icon={<MdDelete />}
                                                                aria-label={t('remove')}
                                                                onClick={() => handleRemoveActionRow(row.id)}
                                                            />
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<MdArrowUpward />}
                                                                aria-label={t('timeline.moveUp', '上移')}
                                                                isDisabled={index === 0}
                                                                onClick={() => moveActionRow(index, -1)}
                                                            />
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<MdArrowDownward />}
                                                                aria-label={t('timeline.moveDown', '下移')}
                                                                isDisabled={index === actionRows.length - 1}
                                                                onClick={() => moveActionRow(index, 1)}
                                                            />
                                                            <IconButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={
                                                                    <Text fontSize="md" fontWeight="bold">
                                                                        +
                                                                    </Text>
                                                                }
                                                                aria-label={t('timeline.addBelow', '在下方添加')}
                                                                onClick={() => handleAddActionRowBelow(index)}
                                                            />
                                                        </HStack>
                                                    </Flex>
                                                </Box>
                                            );
                                        })}
                                        {actionRows.length === 0 && (
                                            <Text fontSize="xs" color="gray.400" textAlign="center" py={2}>
                                                {t('timeline.noActions', '暂无动作')}
                                            </Text>
                                        )}
                                    </VStack>
                                </Collapse>
                            </Box>
                        )}
                    </VStack>
                </RmgSidePanelBody>
            </Box>

            {/* 从线路中添加：选择源线路 */}
            <Modal
                isOpen={addFromLineState.step === 'selectLine'}
                onClose={() => setAddFromLineState({ step: 'idle' })}
                size="sm"
            >
                <ModalOverlay />
                <ModalContent h="90vh" maxH="90vh">
                    <ModalHeader>{t('timeline.selectSourceLine', '选择已分配线路')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody display="flex" flexDirection="column" overflow="hidden">
                        <VStack align="stretch" spacing={2} flex={1} overflowY="auto">
                            {lineExportsForAdd
                                .filter(entry => !entry.error && entry.topology.stationIds.length >= 2)
                                .map(entry => (
                                    <Button
                                        key={entry.line.id}
                                        justifyContent="flex-start"
                                        variant="outline"
                                        onClick={() =>
                                            handleSelectSourceLine(
                                                (addFromLineState as { groupId: string }).groupId,
                                                entry.line.id
                                            )
                                        }
                                    >
                                        <Badge bg={entry.topology.theme[2]} color="white" mr={2} flexShrink={0}>
                                            {entry.line.name[0].trim() ||
                                                entry.line.name[1].trim() ||
                                                (entry.topology.theme[0] === 'other' &&
                                                entry.topology.theme[1] === 'other'
                                                    ? entry.topology.theme[2]
                                                    : entry.topology.theme[1])}
                                        </Badge>
                                        {getLineEndpointsLabel(exportedGraphForAdd!, entry.line)}
                                    </Button>
                                ))}
                        </VStack>
                    </ModalBody>
                </ModalContent>
            </Modal>

            {/* 从线路中添加：选择连续区段（SVG 区间图拖拽选择） */}
            {addFromLineState.step === 'selectInterval' &&
                (() => {
                    const sourceEntry = lineExportsForAdd.find(
                        entry => entry.line.id === addFromLineState.sourceLineId
                    );
                    if (!sourceEntry || sourceEntry.error || !exportedGraphForAdd) return null;
                    return (
                        <SegmentFromLineModal
                            key={sourceEntry.line.id}
                            graph={exportedGraphForAdd}
                            line={sourceEntry.line}
                            onClose={() => setAddFromLineState({ step: 'idle' })}
                            onApply={handleCreateSegmentFromInterval}
                        />
                    );
                })()}

            {/* 目标线路段选择模态框 */}
            <Modal isOpen={!!addElementModal} onClose={() => setAddElementModal(null)} size="sm">
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('timeline.addElement', '添加元素')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <VStack align="stretch" spacing={2}>
                            <Button
                                onClick={() => {
                                    if (!addElementModal) return;
                                    handleStartPickElement(addElementModal.lineId, addElementModal.index);
                                    setAddElementModal(null);
                                }}
                            >
                                {t('timeline.addSingleElement', '添加元素')}
                            </Button>
                            <Button
                                colorScheme="teal"
                                variant="outline"
                                onClick={() => {
                                    if (!addElementModal) return;
                                    handleStartSegmentPick(addElementModal.lineId, addElementModal.index);
                                    setAddElementModal(null);
                                }}
                            >
                                {t('timeline.addSegmentPath', '整段添加')}
                            </Button>
                        </VStack>
                    </ModalBody>
                </ModalContent>
            </Modal>

            <Modal isOpen={segmentModalOpen} onClose={() => setSegmentModalOpen(false)} size="sm">
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('timeline.action.selectSegment', '选择目标线路段')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <VStack align="stretch" spacing={2} maxH="350px" overflowY="auto">
                            {groups.length === 0 ? (
                                <Text fontSize="sm" color="gray.500">
                                    {t('timeline.noGroups', '暂无线路')}
                                </Text>
                            ) : (
                                groups.map(group => {
                                    const groupSegments = lines.filter(l => l.groupId === group.id);
                                    const isExpanded = segmentModalExpandedGroup === group.id;

                                    return (
                                        <Box key={group.id} borderWidth="1px" borderRadius="md" p={1}>
                                            <Flex
                                                align="center"
                                                cursor="pointer"
                                                onClick={() =>
                                                    setSegmentModalExpandedGroup(isExpanded ? null : group.id)
                                                }
                                                p={1}
                                            >
                                                <Badge
                                                    bg={group.bgColor}
                                                    color="white"
                                                    fontSize="xs"
                                                    px={1}
                                                    borderRadius="sm"
                                                    mr={2}
                                                >
                                                    {group.text}
                                                </Badge>
                                                <Text fontSize="xs" color="gray.500">
                                                    ({groupSegments.length} {t('timeline.segments', '段')})
                                                </Text>
                                                <Text fontSize="xs" ml="auto">
                                                    {isExpanded ? '▲' : '▼'}
                                                </Text>
                                            </Flex>

                                            {isExpanded && (
                                                <VStack spacing={1} align="stretch" pl={4} mt={1}>
                                                    {groupSegments.length === 0 ? (
                                                        <Text fontSize="xs" color="gray.400" py={1}>
                                                            {t('timeline.noSegments', '暂无线路段')}
                                                        </Text>
                                                    ) : (
                                                        groupSegments.map(seg => (
                                                            <Flex
                                                                key={seg.id}
                                                                align="center"
                                                                p={1}
                                                                borderRadius="sm"
                                                                cursor="pointer"
                                                                _hover={{ bg: rowBgColor }}
                                                                onClick={() => handleSelectSegment(seg.id)}
                                                            >
                                                                <Badge fontSize="xs" variant="outline" mr={2}>
                                                                    {seg.elements?.length ?? 0}
                                                                </Badge>
                                                                <Text
                                                                    fontSize="xs"
                                                                    flex={1}
                                                                    minWidth={0}
                                                                    noOfLines={1}
                                                                    wordBreak="break-all"
                                                                >
                                                                    {seg.text}
                                                                </Text>
                                                            </Flex>
                                                        ))
                                                    )}
                                                </VStack>
                                            )}
                                        </Box>
                                    );
                                })
                            )}
                        </VStack>
                    </ModalBody>
                    <ModalFooter>
                        <Button size="sm" variant="outline" onClick={() => setSegmentModalOpen(false)}>
                            {t('cancel')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            {/* 整段添加 - 主题选择模态框 */}
            <Modal isOpen={segmentPickState.step === 'pickingTheme'} onClose={handleCancelSegmentPick} size="sm">
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('timeline.selectTheme', '选择线路颜色')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <VStack spacing={3}>
                            <Text fontSize="sm">{t('timeline.selectThemeHint', '请选择路径使用的线条颜色')}</Text>
                            <HStack flexWrap="wrap" spacing={2}>
                                {segmentPickState.step === 'pickingTheme' &&
                                    segmentPickState.themes.map((theme, i) => (
                                        <ThemeButton
                                            key={i}
                                            theme={theme}
                                            onClick={() => {
                                                setSegmentPickState({
                                                    step: 'pickingEndNode',
                                                    lineId: segmentPickState.lineId,
                                                    startNode: segmentPickState.startNode,
                                                    theme,
                                                });
                                            }}
                                        />
                                    ))}
                            </HStack>
                        </VStack>
                    </ModalBody>
                    <ModalFooter>
                        <Button size="sm" variant="outline" onClick={handleCancelSegmentPick}>
                            {t('cancel')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <Modal isOpen={!!addElementModal} onClose={() => setAddElementModal(null)} size="sm">
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('timeline.addElement', '添加内容')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <VStack align="stretch" spacing={2}>
                            <Button
                                onClick={() => {
                                    if (!addElementModal) return;
                                    handleStartPickElement(addElementModal.lineId, addElementModal.index);
                                    setAddElementModal(null);
                                }}
                            >
                                {t('timeline.addSingleElement', '添加元素')}
                            </Button>
                            <Button
                                colorScheme="teal"
                                variant="outline"
                                onClick={() => {
                                    if (!addElementModal) return;
                                    handleStartSegmentPick(addElementModal.lineId, addElementModal.index);
                                    setAddElementModal(null);
                                }}
                            >
                                {t('timeline.addSegmentPath', '整段添加')}
                            </Button>
                        </VStack>
                    </ModalBody>
                </ModalContent>
            </Modal>

            <Modal
                isOpen={!!closeNodeStylesModal}
                onClose={requestCloseNodeStylesModal}
                size={{ base: 'full', md: 'lg' }}
            >
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>停运后换乘站样式</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <VStack align="stretch" spacing={2}>
                            {closeNodeStylesModal &&
                            getCloseStyleNodes(closeNodeStylesModal.actionLineId).length === 0 ? (
                                <Text fontSize="sm" color="gray.500">
                                    目标线路段中没有多版本节点
                                </Text>
                            ) : (
                                closeNodeStylesModal &&
                                getCloseStyleNodes(closeNodeStylesModal.actionLineId).map(nodeId => {
                                    const style = draftCloseNodeStyles[nodeId] ?? { visible: false, version: 1 };
                                    return (
                                        <HStack key={nodeId} p={2} borderWidth="1px" borderRadius="md">
                                            <Text flex={1} fontSize="sm">
                                                {getNodeDisplayName(graph.current, nodeId)}
                                            </Text>
                                            {style.visible && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    rightIcon={<MdExpandMore />}
                                                    onClick={() =>
                                                        setVersionPicker({
                                                            type: 'closeStyle',
                                                            nodeId,
                                                            selectedVersion: style.version,
                                                        })
                                                    }
                                                >
                                                    {getNodeVersionName(nodeId, style.version)}
                                                </Button>
                                            )}
                                            <Text fontSize="sm">停运后显示</Text>
                                            <Switch
                                                isChecked={style.visible}
                                                onChange={event =>
                                                    setDraftCloseNodeStyles(previous => ({
                                                        ...previous,
                                                        [nodeId]: { ...style, visible: event.target.checked },
                                                    }))
                                                }
                                                aria-label={`停运后显示 ${getNodeDisplayName(graph.current, nodeId)}`}
                                            />
                                        </HStack>
                                    );
                                })
                            )}
                        </VStack>
                    </ModalBody>
                    <ModalFooter>
                        <Button size="sm" variant="outline" onClick={requestCloseNodeStylesModal}>
                            {t('cancel', '取消')}
                        </Button>
                        <Button
                            size="sm"
                            colorScheme="teal"
                            ml={2}
                            onClick={() => {
                                if (!closeNodeStylesModal) return;
                                const closeNodeStyles = Object.fromEntries(
                                    Object.entries(draftCloseNodeStyles).filter(([, style]) => style.visible)
                                ) as Record<NodeId, CloseNodeStyle>;
                                dispatch(
                                    updateActionRow({
                                        id: closeNodeStylesModal.id,
                                        updates: { closeNodeStyles },
                                    })
                                );
                                setCloseNodeStylesModal(null);
                                setCloseNodeStylesBeforeEditing({});
                            }}
                        >
                            {t('confirm', '确定')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <AlertDialog
                isOpen={!!discardChangesTarget}
                onClose={() => setDiscardChangesTarget(null)}
                leastDestructiveRef={cancelDiscardRef}
            >
                <AlertDialogOverlay>
                    <AlertDialogContent>
                        <AlertDialogHeader>放弃未保存的更改？</AlertDialogHeader>
                        <AlertDialogBody>关闭后，本次修改将不会保存。</AlertDialogBody>
                        <AlertDialogFooter>
                            <Button ref={cancelDiscardRef} onClick={() => setDiscardChangesTarget(null)}>
                                {t('cancel')}
                            </Button>
                            <Button
                                colorScheme="red"
                                ml={3}
                                onClick={() => {
                                    if (discardChangesTarget === 'action') {
                                        setEditingActionRow(null);
                                        setActionRowBeforeEditing(null);
                                    } else if (discardChangesTarget === 'closeStyle') {
                                        setCloseNodeStylesModal(null);
                                        setCloseNodeStylesBeforeEditing({});
                                    }
                                    setDiscardChangesTarget(null);
                                }}
                            >
                                放弃更改
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialogOverlay>
            </AlertDialog>

            {/* 节点历史版本选择 */}
            <Modal isOpen={!!versionPicker} onClose={() => setVersionPicker(null)} size={{ base: 'full', md: 'md' }}>
                <ModalOverlay />
                <ModalContent maxH={{ base: '100dvh', md: '80vh' }}>
                    <ModalHeader>{t('timeline.selectVersion', '选择历史版本')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody overflowY="auto" px={3}>
                        <VStack align="stretch" spacing={2}>
                            {versionPicker &&
                                getNodeVersionOptions(versionPicker.nodeId).map(version => {
                                    const name = getNodeVersionName(versionPicker.nodeId, version);
                                    const node = graph.current.hasNode(versionPicker.nodeId)
                                        ? graph.current.getNodeAttributes(versionPicker.nodeId)
                                        : undefined;
                                    const versionSnapshot = node
                                        ? getNodeVersion(graph.current, versionPicker.nodeId, version)
                                        : undefined;
                                    const PreviewComponent = versionSnapshot
                                        ? (stations[versionSnapshot.type as StationType]?.component ??
                                          miscNodes[versionSnapshot.type as MiscNodeType]?.component)
                                        : undefined;
                                    const previewAttrs =
                                        node && versionSnapshot
                                            ? ({
                                                  ...node,
                                                  ...versionSnapshot,
                                                  ...(versionSnapshot[
                                                      versionSnapshot.type as keyof typeof versionSnapshot
                                                  ] ?? {}),
                                                  x: 0,
                                                  y: 0,
                                              } as any)
                                            : undefined;
                                    const isSelected = versionPicker.selectedVersion === version;
                                    return (
                                        <HStack
                                            key={version}
                                            minH="55px"
                                            p={2}
                                            borderWidth="1px"
                                            borderColor={isSelected ? 'orange.400' : 'gray.200'}
                                            bg={isSelected ? 'orange.50' : undefined}
                                            borderRadius="md"
                                            cursor="pointer"
                                            transition="all 0.15s"
                                            _hover={{ borderColor: 'orange.300', shadow: 'sm' }}
                                            _active={{ transform: 'scale(0.99)' }}
                                            onClick={() =>
                                                setVersionPicker({ ...versionPicker, selectedVersion: version })
                                            }
                                        >
                                            <Box
                                                boxSize="45px"
                                                flexShrink={0}
                                                borderRadius="sm"
                                                bg="gray.50"
                                                borderWidth="1px"
                                                borderColor="gray.200"
                                                display="flex"
                                                alignItems="center"
                                                justifyContent="center"
                                                overflow="hidden"
                                                cursor="zoom-in"
                                                onClick={event => {
                                                    event.stopPropagation();
                                                    setPreviewVersion({ name, nodeId: versionPicker.nodeId, version });
                                                }}
                                            >
                                                {PreviewComponent && previewAttrs ? (
                                                    <svg
                                                        ref={svg => {
                                                            if (!svg) return;
                                                            requestAnimationFrame(() => {
                                                                const viewBox = fitSvgViewBox(svg);
                                                                if (viewBox) svg.setAttribute('viewBox', viewBox);
                                                            });
                                                        }}
                                                        width="45"
                                                        height="45"
                                                        viewBox="-180 -100 360 200"
                                                        preserveAspectRatio="xMidYMid meet"
                                                    >
                                                        <g>
                                                            <PreviewComponent
                                                                id={versionPicker.nodeId as any}
                                                                x={0}
                                                                y={0}
                                                                attrs={previewAttrs}
                                                                handlePointerDown={() => undefined}
                                                                handlePointerMove={() => undefined}
                                                                handlePointerUp={() => undefined}
                                                            />
                                                        </g>
                                                    </svg>
                                                ) : (
                                                    <Text fontSize="xs">{version === 1 ? 'B' : `V${version}`}</Text>
                                                )}
                                            </Box>
                                            <Text flex={1} whiteSpace="normal" wordBreak="break-word">
                                                {name}
                                            </Text>
                                        </HStack>
                                    );
                                })}
                        </VStack>
                    </ModalBody>
                    <ModalFooter>
                        <Button size="sm" variant="outline" onClick={() => setVersionPicker(null)}>
                            {t('cancel', '取消')}
                        </Button>
                        <Button
                            size="sm"
                            colorScheme="orange"
                            ml={2}
                            onClick={() => {
                                if (!versionPicker) return;
                                if (versionPicker.type === 'element') {
                                    handleSetElementVersion(
                                        versionPicker.lineId,
                                        versionPicker.elementIndex,
                                        versionPicker.selectedVersion
                                    );
                                } else {
                                    setDraftCloseNodeStyles(previous => ({
                                        ...previous,
                                        [versionPicker.nodeId]: {
                                            ...(previous[versionPicker.nodeId] ?? { visible: true, version: 1 }),
                                            version: versionPicker.selectedVersion,
                                        },
                                    }));
                                }
                                setVersionPicker(null);
                            }}
                        >
                            {t('confirm', '确定')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <Modal isOpen={!!previewVersion} onClose={() => setPreviewVersion(null)} size="xl">
                <ModalOverlay />
                <ModalContent width="50vmin" height="50vmin" maxW="50vmin" maxH="50vmin">
                    <ModalHeader>{previewVersion?.name}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody display="flex" flexDirection="column" gap={2} minH={0} p={2}>
                        <Box
                            flex={1}
                            minH={0}
                            overflow="hidden"
                            cursor={previewDragRef.current ? 'grabbing' : 'grab'}
                            sx={{ touchAction: 'none' }}
                            onWheel={event => {
                                event.preventDefault();
                                setPreviewScale(value =>
                                    Math.max(0.5, Math.min(4, value * (event.deltaY < 0 ? 1.1 : 0.9)))
                                );
                            }}
                            onPointerDown={event => {
                                event.currentTarget.setPointerCapture(event.pointerId);
                                previewPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                                if (previewPointersRef.current.size === 2) {
                                    const [first, second] = [...previewPointersRef.current.values()];
                                    previewPinchRef.current = {
                                        distance: Math.hypot(second.x - first.x, second.y - first.y),
                                        scale: previewScale,
                                    };
                                    previewDragRef.current = null;
                                } else {
                                    previewDragRef.current = {
                                        x: event.clientX,
                                        y: event.clientY,
                                        panX: previewPan.x,
                                        panY: previewPan.y,
                                    };
                                }
                            }}
                            onPointerMove={event => {
                                if (!previewPointersRef.current.has(event.pointerId)) return;
                                previewPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                                if (previewPointersRef.current.size >= 2 && previewPinchRef.current) {
                                    const [first, second] = [...previewPointersRef.current.values()];
                                    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
                                    setPreviewScale(
                                        Math.max(
                                            0.5,
                                            Math.min(
                                                4,
                                                previewPinchRef.current.scale *
                                                    (distance / previewPinchRef.current.distance)
                                            )
                                        )
                                    );
                                    return;
                                }
                                const drag = previewDragRef.current;
                                if (!drag) return;
                                setPreviewPan({
                                    x: drag.panX + event.clientX - drag.x,
                                    y: drag.panY + event.clientY - drag.y,
                                });
                            }}
                            onPointerUp={event => {
                                previewPointersRef.current.delete(event.pointerId);
                                previewPinchRef.current = null;
                                previewDragRef.current = null;
                            }}
                            onPointerCancel={event => {
                                previewPointersRef.current.delete(event.pointerId);
                                previewPinchRef.current = null;
                                previewDragRef.current = null;
                            }}
                        >
                            {(() => {
                                if (!previewVersion) return null;
                                const node = graph.current.hasNode(previewVersion.nodeId)
                                    ? graph.current.getNodeAttributes(previewVersion.nodeId)
                                    : undefined;
                                const version = node
                                    ? getNodeVersion(graph.current, previewVersion.nodeId, previewVersion.version)
                                    : undefined;
                                if (!node || !version) return <Text>{previewVersion.nodeId}</Text>;
                                const PreviewComponent =
                                    stations[version.type as StationType]?.component ??
                                    miscNodes[version.type as MiscNodeType]?.component;
                                if (!PreviewComponent) return <Text>{previewVersion.nodeId}</Text>;
                                const previewAttrs = {
                                    ...node,
                                    ...version,
                                    ...(version[version.type as keyof typeof version] ?? {}),
                                    x: 0,
                                    y: 0,
                                } as any;
                                return (
                                    <svg
                                        ref={previewSvgRef}
                                        width="100%"
                                        height="100%"
                                        viewBox={previewViewBox}
                                        preserveAspectRatio="xMidYMid meet"
                                    >
                                        <g
                                            transform={`translate(${previewPan.x} ${previewPan.y}) scale(${previewScale})`}
                                        >
                                            <PreviewComponent
                                                id={previewVersion.nodeId as any}
                                                x={0}
                                                y={0}
                                                attrs={previewAttrs}
                                                handlePointerDown={() => undefined}
                                                handlePointerMove={() => undefined}
                                                handlePointerUp={() => undefined}
                                            />
                                        </g>
                                    </svg>
                                );
                            })()}
                        </Box>
                        <Slider
                            aria-label={t('timeline.previewZoom', '预览缩放')}
                            min={0.5}
                            max={4}
                            step={0.05}
                            value={previewScale}
                            onChange={setPreviewScale}
                        >
                            <SliderTrack>
                                <SliderFilledTrack />
                            </SliderTrack>
                            <SliderThumb />
                        </Slider>
                    </ModalBody>
                </ModalContent>
            </Modal>

            {/* 非法日期修复模态框 */}
            <InvalidDateModal
                isOpen={invalidDateModalOpen}
                invalidEntries={invalidDateEntries}
                onClearOne={handleModalClearOne}
                onClearAll={handleModalClearAll}
                onFix={handleModalFix}
                onClose={handleModalIgnore}
            />

            {/* 元素操作二次确认模态框 */}
            <Modal isOpen={!!elementConfirm} onClose={() => setElementConfirm(null)} size="sm">
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('timeline.confirmClearElements', '删除全部元素')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <Text fontSize="sm">
                            {t('timeline.confirmClearElementsHint', '确定要删除该线路段的全部元素吗？')}
                        </Text>
                    </ModalBody>
                    <ModalFooter>
                        <Button size="sm" variant="outline" onClick={() => setElementConfirm(null)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            size="sm"
                            colorScheme={elementConfirm?.type === 'clearElements' ? 'red' : 'orange'}
                            ml={2}
                            onClick={handleExecuteElementConfirm}
                        >
                            {t('confirm')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </RmgSidePanel>
    );
}
