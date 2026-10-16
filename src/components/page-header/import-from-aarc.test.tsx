import { RmgThemeProvider } from '@railmapgen/rmg-components';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MultiDirectedGraph } from 'graphology';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeAttributes, Id, NodeAttributes } from '../../constants/constants';
import { DEFAULT_MAP_STYLE } from '../../map/map-style';
import { createStore } from '../../redux';
import { setMapEnabled, setMapStyle } from '../../redux/param/param-slice';
import { setSelected } from '../../redux/runtime/runtime-slice';
import { setTimelineEnabled } from '../../redux/timeline/timeline-slice';
import { render } from '../../test-utils';
import { convertAARCToRmp } from '../../util/import-from-aarc';
import { BsbldImportResult, convertBsbldToRmp } from '../../util/import-from-bsbld';
import ImportFromAarc from './import-from-aarc';

vi.mock('../../util/change-types', async importOriginal => {
    const actual = await importOriginal<typeof import('../../util/change-types')>();
    return {
        ...actual,
        autoPopulateTransfer: vi.fn(),
        changeStationsTypeInBatch: vi.fn(),
    };
});

vi.mock('../../util/import-from-aarc', async importOriginal => {
    const actual = await importOriginal<typeof import('../../util/import-from-aarc')>();
    return {
        ...actual,
        convertAARCToRmp: vi.fn(),
    };
});

vi.mock('../../util/import-from-bsbld', () => ({
    isBsbldSave: (data: { fictionalMode?: unknown }) => typeof data?.fictionalMode === 'boolean',
    convertBsbldToRmp: vi.fn(),
}));

const timeline = {
    totalDuration: 60,
    currentTime: 0,
    dateRows: [],
    groups: [{ id: 'group_1', bgColor: '#123456', text: 'Line 1' }],
    lines: [{ id: 'timeline_line_1', groupId: 'group_1', text: 'Line 1', elements: [{ id: 'line_bsbld_a' }] }],
    actionRows: [
        {
            id: 'action_1',
            date: '1959-10-30',
            activeLineIds: ['group_1'],
            remark: '',
            actionType: 'open' as const,
            actionLineId: 'timeline_line_1',
        },
    ],
    diffs: [],
};

const importBsbld = async (history: boolean) => {
    const file = new File([JSON.stringify({ fictionalMode: false, history })], 'network.json', {
        type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Upload JSON file'), { target: { files: [file] } });
    const next = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    return screen.findByRole('button', { name: 'Clear current and Overwrite' });
};

describe('ImportFromAarc', () => {
    beforeEach(() => {
        window.graph = new MultiDirectedGraph();
        vi.mocked(convertAARCToRmp).mockImplementation((_text, graph) => {
            graph.addNode('stn_a', {} as NodeAttributes);
            graph.addNode('stn_b', {} as NodeAttributes);
            graph.addDirectedEdgeWithKey('line_a', 'stn_a', 'stn_b', {} as EdgeAttributes);
        });
        vi.mocked(convertBsbldToRmp).mockImplementation((text, graph) => {
            graph.addNode('stn_bsbld_a', {} as NodeAttributes);
            graph.addNode('stn_bsbld_b', {} as NodeAttributes);
            graph.addDirectedEdgeWithKey('line_bsbld_a', 'stn_bsbld_a', 'stn_bsbld_b', {} as EdgeAttributes);
            return { fictionalMode: false, ...(JSON.parse(text).history ? { timeline } : {}) } as BsbldImportResult;
        });
        vi.stubGlobal(
            'matchMedia',
            vi.fn().mockReturnValue({
                matches: false,
                media: '',
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('preserves AARC map settings and clears selection when parsing the import', async () => {
        const store = createStore();
        const mapStyle = structuredClone(DEFAULT_MAP_STYLE);
        mapStyle.roads.arterial.color = '#123456';
        store.dispatch(setMapEnabled(true));
        store.dispatch(setMapStyle(mapStyle));
        store.dispatch(setSelected(new Set<Id>(['misc_node_stale'])));
        render(
            <RmgThemeProvider>
                <ImportFromAarc isOpen={true} onClose={vi.fn()} />
            </RmgThemeProvider>,
            { store }
        );

        const file = new File(['{}'], 'aarc.json', { type: 'application/json' });
        fireEvent.change(screen.getByLabelText('Upload JSON file'), { target: { files: [file] } });

        const next = screen.getByRole('button', { name: 'Next' });
        await waitFor(() => expect(next).toBeEnabled());
        fireEvent.click(next);
        const overwrite = await screen.findByRole('button', { name: 'Clear current and Overwrite' });

        expect(store.getState().runtime.selected.size).toBe(0);

        fireEvent.click(overwrite);
        expect(store.getState().param.present.mapEnabled).toBe(true);
        expect(store.getState().param.present.mapStyle).toEqual(mapStyle);
        expect(store.getState().runtime.selected.size).toBe(0);
    });

    it('shows the configuration-only error for a root-level AARC config file', async () => {
        vi.mocked(convertAARCToRmp).mockImplementation(() => {
            throw new Error('Invalid AARC save data');
        });
        const store = createStore();
        render(
            <RmgThemeProvider>
                <ImportFromAarc isOpen={true} onClose={vi.fn()} />
            </RmgThemeProvider>,
            { store }
        );

        const file = new File([JSON.stringify({ configVersion: 2, snapRayAngles: [] })], 'config.json', {
            type: 'application/json',
        });
        fireEvent.change(screen.getByLabelText('Upload JSON file'), { target: { files: [file] } });

        const next = screen.getByRole('button', { name: 'Next' });
        await waitFor(() => expect(next).toBeEnabled());
        fireEvent.click(next);

        expect(await screen.findByText(/configuration/i)).toBeInTheDocument();
        expect(screen.queryByText(/unsupported/i)).not.toBeInTheDocument();
    });

    it('recognizes a real-map bsbld save and enables the map', async () => {
        const store = createStore();
        store.dispatch(setMapEnabled(false));
        store.dispatch(setTimelineEnabled(true));
        render(
            <RmgThemeProvider>
                <ImportFromAarc isOpen={true} onClose={vi.fn()} />
            </RmgThemeProvider>,
            { store }
        );

        const overwrite = await importBsbld(false);

        expect(convertBsbldToRmp).toHaveBeenCalledTimes(1);
        expect(convertAARCToRmp).not.toHaveBeenCalled();
        expect(await screen.findByText(/bsbld/)).toBeInTheDocument();

        fireEvent.click(overwrite);
        expect(store.getState().param.present.mapEnabled).toBe(true);
        expect(store.getState().timeline.enabled).toBe(false);
    });

    it('loads bsbld history when the timeline is enabled before import', async () => {
        const store = createStore();
        store.dispatch(setTimelineEnabled(true));
        render(
            <RmgThemeProvider>
                <ImportFromAarc isOpen={true} onClose={vi.fn()} />
            </RmgThemeProvider>,
            { store }
        );

        fireEvent.click(await importBsbld(true));

        expect(store.getState().timeline.enabled).toBe(true);
        expect(store.getState().timeline.actionRows).not.toHaveLength(0);
    });

    it('does not load bsbld history when the timeline is disabled before import', async () => {
        const store = createStore();
        render(
            <RmgThemeProvider>
                <ImportFromAarc isOpen={true} onClose={vi.fn()} />
            </RmgThemeProvider>,
            { store }
        );

        fireEvent.click(await importBsbld(true));

        expect(store.getState().timeline.enabled).toBe(false);
        expect(store.getState().timeline.actionRows).toHaveLength(0);
    });
});
