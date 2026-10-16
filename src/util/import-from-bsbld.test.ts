import { MultiDirectedGraph } from 'graphology';
import { describe, expect, it } from 'vitest';
import { EdgeAttributes, GraphAttributes, NodeAttributes } from '../constants/constants';
import { LinePathType, LineStyleType } from '../constants/lines';
import { convertBsbldToRmp, isBsbldSave } from './import-from-bsbld';

const save = {
    fictionalMode: true,
    pts: [
        { id: 1, x: 0, y: 0, sta: true, staid: 10 },
        { id: 2, x: 100, y: 100 },
        { id: 3, x: 200, y: 0, sta: true, staid: 20 },
        { id: 4, x: 200, y: 0, sta: true, staid: 20 },
    ],
    lines: [{ id: 5, pts: [1, 2, 3, 4], color: '#123456' }],
    names: [
        { staid: 10, name: '起点' },
        { staid: 20, name: '终点' },
    ],
};

describe('import from bsbld', () => {
    it('recognizes the static bsbld save structure', () => {
        expect(isBsbldSave(save)).toBe(true);
        expect(isBsbldSave({ fictionalMode: true, pts: [], lines: [] })).toBe(false);
        expect(
            isBsbldSave({
                format: 'BinshuLD3Work',
                schemaVersion: 3,
                document: { fictionalMode: true, pts: [], lines: [], names: [] },
            })
        ).toBe(true);
    });

    it('imports a BinshuLD3Work document', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        const result = convertBsbldToRmp(
            JSON.stringify({
                format: 'BinshuLD3Work',
                schemaVersion: 3,
                document: {
                    fictionalMode: true,
                    pts: [
                        { id: 1, lng: 0, lat: 0, sta: true, staid: 1 },
                        { id: 2, lng: 1, lat: 0 },
                        { id: 3, lng: 2, lat: 0, sta: true, staid: 3 },
                    ],
                    lines: [{ id: 1, name: '1号线', color: '#ff0000', pts: [1, 2, 3] }],
                    names: [
                        { staid: 1, name: '起点' },
                        { staid: 3, name: '终点' },
                    ],
                },
            }),
            graph
        );

        expect(result.fictionalMode).toBe(true);
        expect(graph.nodes()).toEqual(['stn_bsbld_1', 'misc_node_bsbld_2', 'stn_bsbld_3']);
        expect(graph.edges()).toEqual(['line_bsbld_1_0', 'line_bsbld_1_1']);
    });

    it('merges station points by staid and creates bezier edges', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        const result = convertBsbldToRmp(JSON.stringify(save), graph);

        expect(result.fictionalMode).toBe(true);
        expect(result.timeline).toBeUndefined();
        expect(graph.nodes()).toEqual(['stn_bsbld_10', 'misc_node_bsbld_2', 'stn_bsbld_20']);
        expect(graph.edges()).toEqual(['line_bsbld_5_0', 'line_bsbld_5_1']);
        expect(graph.getEdgeAttribute('line_bsbld_5_0', 'type')).toBe(LinePathType.Bezier);
        expect(graph.getEdgeAttribute('line_bsbld_5_0', 'style')).toBe(LineStyleType.SingleColor);
        expect(graph.getEdgeAttribute('line_bsbld_5_0', 'reconcileId')).toBe('');
        expect(graph.getEdgeAttribute('line_bsbld_5_0', LineStyleType.SingleColor)).toEqual({
            color: ['other', 'bsbld-5', '#123456', '#fff'],
        });
    });

    it('keeps lng lat positions distinct for fictional saves', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        convertBsbldToRmp(
            JSON.stringify({
                fictionalMode: true,
                pts: [
                    { id: 1, lng: 120.1, lat: 30.2 },
                    { id: 2, lng: 120.2, lat: 30.3 },
                ],
                lines: [{ id: 5, pts: [1, 2] }],
                names: [],
            }),
            graph
        );

        const first = graph.getNodeAttributes('misc_node_bsbld_1');
        const second = graph.getNodeAttributes('misc_node_bsbld_2');
        expect({ x: first.x, y: first.y }).not.toEqual({ x: second.x, y: second.y });
        expect(Math.abs(first.x)).toBeLessThan(100);
        expect(Math.abs(first.y)).toBeLessThan(100);
    });

    it('creates timeline data from history segments', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        const result = convertBsbldToRmp(
            JSON.stringify({
                fictionalMode: true,
                pts: [
                    { id: 1, x: 0, y: 0 },
                    { id: 2, x: 100, y: 0 },
                    { id: 3, x: 200, y: 0 },
                ],
                lines: [{ id: 5, name: '测试线路', pts: [1, 2, 3], color: '#123456' }],
                names: [],
                timeVars: [{ key: 'a', value: '1958/10/30' }],
                historySegments: [
                    { id: 1, ownerId: 5, action: 'open', time: 'a+1y', fromPtId: 1, toPtId: 3 },
                    { id: 2, ownerId: 5, action: 'unsupported', time: 'a', fromPtId: 1, toPtId: 2 },
                ],
            }),
            graph
        );

        expect(result.timeline).toMatchObject({
            groups: [{ id: 'bsbld_group_5', bgColor: '#123456', text: '测试线路' }],
            lines: [
                {
                    id: 'bsbld_timeline_line_1',
                    groupId: 'bsbld_group_5',
                    text: '线路段1',
                    elements: [
                        { id: 'misc_node_bsbld_1' },
                        { id: 'line_bsbld_5_0' },
                        { id: 'misc_node_bsbld_2' },
                        { id: 'line_bsbld_5_1' },
                        { id: 'misc_node_bsbld_3' },
                    ],
                    mileage: 200,
                },
            ],
            actionRows: [
                {
                    id: 'bsbld_action_1',
                    date: '1959-10-30',
                    actionType: 'open',
                    activeLineIds: ['bsbld_group_5'],
                    actionLineId: 'bsbld_timeline_line_1',
                    actionDuration: 1.5,
                    useSuggestedDuration: false,
                },
                { id: 'bsbld_action_1_overview', actionType: 'overview', actionDuration: 9 },
                { id: 'bsbld_action_1_wait', actionType: 'wait', actionDuration: 2 },
            ],
        });
    });
});
