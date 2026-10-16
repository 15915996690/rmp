import {
    AlertDialog,
    AlertDialogBody,
    AlertDialogContent,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogOverlay,
    Badge,
    Box,
    Button,
    Collapse,
    Flex,
    FormControl,
    FormErrorMessage,
    FormLabel,
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
    SimpleGrid,
    Stack,
    Text,
    Textarea,
} from '@chakra-ui/react';
import { RmgLineBadge } from '@railmapgen/rmg-components';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MdAltRoute, MdCallMerge, MdChevronRight, MdClose, MdEdit, MdExpandMore, MdRestore } from 'react-icons/md';
import type { LineDefinition, LineOperatingStatus } from '../../constants/line-definitions';
import { useRootDispatch, useRootSelector } from '../../redux';
import { ParamGraph, saveGraph } from '../../redux/param/param-slice';
import {
    assignLineSection,
    getLineAssignmentTargets,
    getLineEndpointsLabel,
    getLineMergeSuggestions,
    getLineTopology,
    getStationLabel,
    getUnassignedLineSections,
    isOpeningDateValid,
    mergeLineDefinitions,
    reconcileLineDefinitions,
    unassignLineDefinition,
} from '../../util/line-definitions';
import { getLineExports, LineExport } from '../../util/line-export';
import { LineIntervalModal } from './line-interval-modal';

const STATUSES: LineOperatingStatus[] = ['planned', 'construction', 'operating', 'closed'];

type DrawerKey = 'assigned' | 'unassigned' | 'complex' | 'suggestions';

/** Sub-drawer inside line settings. Multiple sub-drawers may stay open at the same time. */
const SubDrawer = ({
    title,
    count,
    isOpen,
    onToggle,
    children,
}: {
    title: string;
    count: number;
    isOpen: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) => (
    <Box borderWidth="1px" borderRadius="md">
        <Flex
            as="button"
            type="button"
            w="full"
            px="2"
            py="1.5"
            justify="space-between"
            align="center"
            onClick={onToggle}
        >
            <HStack spacing="2">
                <Text fontSize="sm" as="b">
                    {title}
                </Text>
                <Badge colorScheme="gray">{count}</Badge>
            </HStack>
            {isOpen ? <MdExpandMore /> : <MdChevronRight />}
        </Flex>
        <Collapse in={isOpen} animateOpacity>
            <Stack p="2" spacing="2">
                {children}
            </Stack>
        </Collapse>
    </Box>
);

/** Each input owns its draft so a sibling's save cannot reset unfinished typing. */
const AutosaveTextField = ({
    label,
    value,
    onSave,
    date = false,
    multiline = false,
}: {
    label: string;
    value: string;
    onSave: (value: string) => void;
    date?: boolean;
    multiline?: boolean;
}) => {
    const { t } = useTranslation();
    const [draft, setDraft] = React.useState(value);
    React.useEffect(() => setDraft(value), [value]);
    const inputProps = {
        size: 'sm' as const,
        value: draft,
        'aria-label': label,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
        onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            const next = event.currentTarget.value;
            if (next !== value && (!date || isOpeningDateValid(next))) onSave(next);
        },
    };
    return (
        <FormControl isInvalid={date && !isOpeningDateValid(draft)}>
            <FormLabel fontSize="sm">{label}</FormLabel>
            {multiline ? (
                <Textarea {...inputProps} />
            ) : (
                <Input {...inputProps} type="text" placeholder={date ? 'YYYY-MM-DD' : undefined} />
            )}
            {date && <FormErrorMessage>{t('header.lineInfo.invalidDate')}</FormErrorMessage>}
        </FormControl>
    );
};

const LineInfoRow = ({
    entry,
    graph,
    onEdit,
    onRemove,
}: {
    entry: LineExport;
    graph: ParamGraph;
    onEdit: () => void;
    onRemove: () => void;
}) => {
    const { t } = useTranslation();
    const { line, topology } = entry;
    const chineseName = line.name[0].trim();
    const colorName =
        topology.theme[0] === 'other' && topology.theme[1] === 'other' ? topology.theme[2] : topology.theme[1];
    return (
        <Box borderWidth="1px" borderRadius="md" p="2" data-testid={`line-info-${line.id}`}>
            <HStack flexWrap="wrap" spacing="3">
                <RmgLineBadge name={chineseName || colorName} bg={topology.theme[2]} fg={topology.theme[3]} />
                <Text flex="1" minW="120px" fontSize="sm">
                    {getLineEndpointsLabel(graph, line)}
                </Text>
                <Badge>{t(`header.download.2rmg.type.${topology.type.toLowerCase()}`)}</Badge>
                <IconButton
                    size="sm"
                    variant="ghost"
                    icon={<MdEdit />}
                    title={t('edit', '编辑')}
                    aria-label={`${t('edit', '编辑')}: ${getLineEndpointsLabel(graph, line)}`}
                    onClick={onEdit}
                />
                <IconButton
                    size="sm"
                    variant="ghost"
                    icon={<MdClose />}
                    title={t('header.lineInfo.removeLine')}
                    aria-label={`${t('header.lineInfo.removeLine')}: ${getLineEndpointsLabel(graph, line)}`}
                    onClick={onRemove}
                />
            </HStack>
            {entry.error && (
                <Text mt="2" fontSize="sm" color="orange.600">
                    {t(`header.lineInfo.${entry.error}`)}
                </Text>
            )}
        </Box>
    );
};

const UnassignedLineRow = ({
    line,
    graph,
    onAssign,
}: {
    line: LineDefinition;
    graph: ParamGraph;
    onAssign: (targetId?: string) => void;
}) => {
    const { t } = useTranslation();
    const theme = getLineTopology(graph, line).theme;
    const chineseName = line.name[0].trim();
    const colorName = theme[0] === 'other' && theme[1] === 'other' ? theme[2] : theme[1];
    const endpoints = getLineEndpointsLabel(graph, line);
    const targets = getLineAssignmentTargets(graph, line.id).filter(
        target => getLineTopology(graph, target).stationIds.length >= 2
    );
    const [targetId, setTargetId] = React.useState('new');
    const selectedTarget = targets.some(item => item.id === targetId) ? targetId : 'new';
    return (
        <Box borderWidth="1px" borderRadius="md" p="2">
            <HStack flexWrap="wrap" spacing="3">
                <RmgLineBadge name={chineseName || colorName} bg={theme[2]} fg={theme[3]} />
                <Text flex="1" minW="120px" fontSize="sm">
                    {endpoints}
                </Text>
                <HStack width={{ base: '100%', sm: 'auto' }}>
                    <Select
                        size="sm"
                        width={{ base: '100%', sm: '200px' }}
                        value={selectedTarget}
                        aria-label={`${t('header.lineInfo.assignmentTarget')}: ${endpoints}`}
                        onChange={event => setTargetId(event.target.value)}
                    >
                        <option value="new">{t('header.lineInfo.newLine')}</option>
                        {targets.map(item => (
                            <option key={item.id} value={item.id}>
                                {item.name.filter(Boolean).join('/') || t('header.lineInfo.unnamed')}
                                {'·'}
                                {getLineEndpointsLabel(graph, item)}
                            </option>
                        ))}
                    </Select>
                    <Button
                        size="sm"
                        colorScheme="blue"
                        flexShrink="0"
                        aria-label={`${t('header.lineInfo.assignInterval')}: ${endpoints}`}
                        onClick={() => onAssign(selectedTarget === 'new' ? undefined : selectedTarget)}
                    >
                        {t('header.lineInfo.assignInterval')}
                    </Button>
                </HStack>
            </HStack>
        </Box>
    );
};

const MergeGroupRow = ({
    group,
    graph,
    onMerge,
}: {
    group: LineDefinition[];
    graph: ParamGraph;
    onMerge: () => void;
}) => {
    const { t } = useTranslation();
    const theme = getLineTopology(graph, group[0]).theme;
    const colorName = theme[0] === 'other' && theme[1] === 'other' ? theme[2] : theme[1];
    return (
        <Box borderWidth="1px" borderRadius="md" p="2">
            <Stack spacing="1">
                {group.map(line => (
                    <HStack key={line.id} spacing="3">
                        <RmgLineBadge name={line.name[0].trim() || colorName} bg={theme[2]} fg={theme[3]} />
                        <Text fontSize="sm">{getLineEndpointsLabel(graph, line)}</Text>
                    </HStack>
                ))}
            </Stack>
            <Button mt="2" size="sm" w="full" colorScheme="blue" leftIcon={<MdCallMerge />} onClick={onMerge}>
                {t('timeline.mergeLines', '一键合并')}
            </Button>
        </Box>
    );
};

export const LineInfoModal = ({
    isOpen,
    onClose,
    embedded = false,
    search: externalSearch,
}: {
    isOpen?: boolean;
    onClose?: () => void;
    embedded?: boolean;
    search?: string;
}) => {
    const { t } = useTranslation();
    const dispatch = useRootDispatch();
    const graph = useRootSelector(state => state.param.present.graph);
    const active = embedded || Boolean(isOpen);
    const search = externalSearch ?? '';
    const entries = React.useMemo(
        () => (active ? getLineExports(graph).filter(entry => entry.topology.stationIds.length >= 2) : []),
        [active, graph]
    );
    const matchesSearch = (value: string) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    const filteredEntries = entries.filter(entry =>
        matchesSearch(
            `${entry.line.name.join(' ')} ${entry.line.lineNumber} ${getLineEndpointsLabel(graph, entry.line)}`
        )
    );
    const assignedEntries = filteredEntries.filter(entry => !entry.error);
    const complexEntries = filteredEntries.filter(entry => Boolean(entry.error));
    const unassigned = React.useMemo(
        () =>
            active
                ? getUnassignedLineSections(graph)
                      .filter(line => getLineTopology(graph, line).stationIds.length >= 2)
                      .filter(line =>
                          matchesSearch(
                              `${line.name.join(' ')} ${line.lineNumber} ${getLineEndpointsLabel(graph, line)}`
                          )
                      )
                : [],
        [active, graph, search]
    );
    const mergeGroups = React.useMemo(
        () =>
            active
                ? getLineMergeSuggestions(graph).filter(group =>
                      group.some(line =>
                          matchesSearch(
                              `${line.name.join(' ')} ${line.lineNumber} ${getLineEndpointsLabel(graph, line)}`
                          )
                      )
                  )
                : [],
        [active, graph, search]
    );
    const [openDrawers, setOpenDrawers] = React.useState<Record<DrawerKey, boolean>>({
        assigned: true,
        unassigned: false,
        complex: false,
        suggestions: false,
    });
    const toggleDrawer = (key: DrawerKey) => setOpenDrawers(current => ({ ...current, [key]: !current[key] }));
    const [editingId, setEditingId] = React.useState<string>();
    const [editingDetailsId, setEditingDetailsId] = React.useState<string>();
    const [isRestoreConfirmOpen, setIsRestoreConfirmOpen] = React.useState(false);
    const restoreCancelRef = React.useRef<HTMLButtonElement>(null);
    const editingLine = graph.attributes?.lineDefinitions?.find(line => line.id === editingId);
    const editingDetailsLine = graph.attributes?.lineDefinitions?.find(line => line.id === editingDetailsId);
    const editingDetailsEntry = entries.find(entry => entry.line.id === editingDetailsId);
    const close = () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setEditingId(undefined);
        setEditingDetailsId(undefined);
        onClose?.();
    };
    const update = (id: string, patch: Partial<LineDefinition>) => {
        const definitions = window.graph.getAttribute('lineDefinitions') ?? [];
        window.graph.setAttribute(
            'lineDefinitions',
            definitions.map(line => (line.id === id ? { ...line, ...patch } : line))
        );
        dispatch(saveGraph(window.graph.export()));
    };
    const apply = (next: ParamGraph) => {
        window.graph.replaceAttributes(structuredClone(next.attributes));
        dispatch(saveGraph(window.graph.export()));
    };
    const restoreDefault = () => {
        const current = window.graph.export();
        const resetGraph: ParamGraph = {
            ...current,
            attributes: {
                ...current.attributes,
                lineDefinitions: [],
                unassignedLineEdgeIds: [],
            },
        };
        apply(reconcileLineDefinitions(resetGraph));
    };
    const renderLine = (entry: LineExport) => (
        <LineInfoRow
            key={entry.line.id}
            entry={entry}
            graph={graph}
            onEdit={() => setEditingDetailsId(entry.line.id)}
            onRemove={() => apply(unassignLineDefinition(window.graph.export(), entry.line.id))}
        />
    );
    const noLineText = (
        <Text fontSize="sm" color="gray.500">
            {t('header.download.2rmg.noline')}
        </Text>
    );
    const content = (
        <Stack spacing="2">
            <Button size="sm" leftIcon={<MdRestore />} onClick={() => setIsRestoreConfirmOpen(true)}>
                {t('timeline.restoreDefault', '恢复默认')}
            </Button>
            <SubDrawer
                title={t('timeline.assignedLines', '已分配线路')}
                count={assignedEntries.length}
                isOpen={openDrawers.assigned}
                onToggle={() => toggleDrawer('assigned')}
            >
                {assignedEntries.length === 0 ? noLineText : assignedEntries.map(renderLine)}
            </SubDrawer>
            <SubDrawer
                title={t('timeline.unassignedIntervals', '未分配区间')}
                count={unassigned.length}
                isOpen={openDrawers.unassigned}
                onToggle={() => toggleDrawer('unassigned')}
            >
                {unassigned.length === 0
                    ? noLineText
                    : unassigned.map(line => (
                          <UnassignedLineRow
                              key={line.id}
                              line={line}
                              graph={graph}
                              onAssign={targetId => apply(assignLineSection(window.graph.export(), line.id, targetId))}
                          />
                      ))}
            </SubDrawer>
            <SubDrawer
                title={t('timeline.complexLines', '复杂线路')}
                count={complexEntries.length}
                isOpen={openDrawers.complex}
                onToggle={() => toggleDrawer('complex')}
            >
                {complexEntries.length === 0 ? noLineText : complexEntries.map(renderLine)}
            </SubDrawer>
            <SubDrawer
                title={t('timeline.suggestedMerges', '建议合并')}
                count={mergeGroups.length}
                isOpen={openDrawers.suggestions}
                onToggle={() => toggleDrawer('suggestions')}
            >
                {mergeGroups.length === 0
                    ? noLineText
                    : mergeGroups.map((group, index) => (
                          <MergeGroupRow
                              key={index}
                              group={group}
                              graph={graph}
                              onMerge={() =>
                                  apply(
                                      mergeLineDefinitions(
                                          window.graph.export(),
                                          group.map(line => line.id)
                                      )
                                  )
                              }
                          />
                      ))}
            </SubDrawer>
        </Stack>
    );
    const details = editingDetailsLine && editingDetailsEntry && (
        <Modal
            isOpen={Boolean(editingDetailsLine)}
            onClose={() => setEditingDetailsId(undefined)}
            size="xl"
            scrollBehavior="inside"
        >
            <ModalOverlay />
            <ModalContent>
                <ModalHeader>
                    {editingDetailsLine.name.filter(Boolean).join(' / ') || t('header.lineInfo.unnamed')}
                </ModalHeader>
                <ModalCloseButton />
                <ModalBody>
                    <SimpleGrid columns={{ base: 1, md: 2 }} spacing="3">
                        {([0, 1] as const).map(index => (
                            <AutosaveTextField
                                key={index}
                                label={t(`header.download.2rmg.placeholder.${index === 0 ? 'chinese' : 'english'}`)}
                                value={editingDetailsLine.name[index]}
                                onSave={value => {
                                    const name: [string, string] = [...editingDetailsLine.name];
                                    name[index] = value.trim();
                                    update(editingDetailsLine.id, { name });
                                }}
                            />
                        ))}
                        {(['lineNumber', 'openingDate', 'operator'] as const).map(field => (
                            <AutosaveTextField
                                key={field}
                                label={t(`header.lineInfo.${field}`)}
                                value={editingDetailsLine[field]}
                                date={field === 'openingDate'}
                                onSave={value => update(editingDetailsLine.id, { [field]: value })}
                            />
                        ))}
                        <FormControl>
                            <FormLabel fontSize="sm">{t('header.lineInfo.status')}</FormLabel>
                            <Select
                                size="sm"
                                value={editingDetailsLine.status}
                                aria-label={t('header.lineInfo.status')}
                                onChange={event =>
                                    update(editingDetailsLine.id, {
                                        status: event.target.value as LineOperatingStatus,
                                    })
                                }
                            >
                                {STATUSES.map(status => (
                                    <option key={status} value={status}>
                                        {t(`header.lineInfo.statuses.${status}`)}
                                    </option>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControl>
                            <FormLabel fontSize="sm">{t('header.lineInfo.exportStart')}</FormLabel>
                            <Select
                                size="sm"
                                value={editingDetailsLine.exportStartStationId}
                                aria-label={t('header.lineInfo.exportStart')}
                                onChange={event =>
                                    update(editingDetailsLine.id, {
                                        exportStartStationId: event.target.value,
                                    })
                                }
                            >
                                {(editingDetailsEntry.startCandidates.length
                                    ? editingDetailsEntry.startCandidates
                                    : editingDetailsEntry.topology.startCandidates
                                ).map(id => (
                                    <option key={id} value={id}>
                                        {getStationLabel(graph, id)}
                                    </option>
                                ))}
                            </Select>
                        </FormControl>
                        <AutosaveTextField
                            label={t('header.lineInfo.notes')}
                            value={editingDetailsLine.notes}
                            multiline
                            onSave={value => update(editingDetailsLine.id, { notes: value })}
                        />
                    </SimpleGrid>
                </ModalBody>
                <ModalFooter>
                    <Button
                        mr="auto"
                        colorScheme="blue"
                        leftIcon={<MdAltRoute />}
                        onClick={() => {
                            setEditingDetailsId(undefined);
                            setEditingId(editingDetailsLine.id);
                        }}
                    >
                        {t('header.lineInfo.adjustInterval')}
                    </Button>
                    <Button variant="outline" onClick={() => setEditingDetailsId(undefined)}>
                        {t('close')}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
    const interval = editingLine && (
        <LineIntervalModal
            key={editingLine.id}
            graph={graph}
            line={editingLine}
            onClose={() => setEditingId(undefined)}
            onApply={preview => {
                apply(preview);
                setEditingId(undefined);
            }}
        />
    );
    const restoreDialog = (
        <AlertDialog
            isOpen={isRestoreConfirmOpen}
            leastDestructiveRef={restoreCancelRef}
            onClose={() => setIsRestoreConfirmOpen(false)}
        >
            <AlertDialogOverlay />
            <AlertDialogContent>
                <AlertDialogHeader>{t('timeline.restoreDefault', '恢复默认')}</AlertDialogHeader>
                <AlertDialogBody>
                    {t('timeline.restoreDefaultConfirm', '确定要清空当前线路设置并重新自动计算吗？')}
                </AlertDialogBody>
                <AlertDialogFooter>
                    <Button ref={restoreCancelRef} onClick={() => setIsRestoreConfirmOpen(false)}>
                        {t('cancel', '取消')}
                    </Button>
                    <Button
                        colorScheme="red"
                        ml={3}
                        onClick={() => {
                            restoreDefault();
                            setIsRestoreConfirmOpen(false);
                        }}
                    >
                        {t('confirm', '确定')}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
    if (embedded) {
        return (
            <>
                {content}
                {details}
                {interval}
                {restoreDialog}
            </>
        );
    }
    return (
        <>
            <Modal
                isOpen={isOpen ?? false}
                onClose={close}
                size="4xl"
                scrollBehavior="inside"
                blockScrollOnMount={false}
            >
                <ModalOverlay />
                <ModalContent>
                    <ModalHeader>{t('header.lineInfo.title')}</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>{content}</ModalBody>
                    <ModalFooter>
                        <Button variant="outline" onClick={close}>
                            {t('close')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
            {isOpen && details}
            {isOpen && interval}
            {restoreDialog}
        </>
    );
};
