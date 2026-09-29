<?php
require_once __DIR__ . '/../config/db.php';

$method = $_SERVER['REQUEST_METHOD'];
$settings = load_settings($conn);

function today_in_timezone(array $settings) {
    $tzName = $settings['timezone'] ?? 'America/New_York';
    try {
        $tz = new DateTimeZone($tzName);
    } catch (Exception $e) {
        $tz = new DateTimeZone('America/New_York');
    }
    return (new DateTime('now', $tz))->format('Y-m-d');
}

function validate_entry_hours($hours, array $settings) {
    $max = (float) ($settings['max_hours_per_day'] ?? 24);
    $inc = (float) ($settings['hour_increment'] ?? 0.25);
    if ($hours < 0 || $hours > $max) {
        return "Hours must be between 0 and {$max}";
    }
    if ($inc > 0) {
        $scaled = round($hours / $inc);
        if (abs($hours - ($scaled * $inc)) > 0.001) {
            return "Hours must be in increments of {$inc}";
        }
    }
    return null;
}

if ($method === 'GET') {
    $from = $_GET['from'] ?? '';
    $to = $_GET['to'] ?? '';
    $projectIds = trim($_GET['project_ids'] ?? '');

    if ($from === '' || $to === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
        json_response(['ok' => false, 'error' => 'Valid from and to dates (YYYY-MM-DD) are required'], 400);
    }
    if ($from > $to) {
        json_response(['ok' => false, 'error' => 'from date must be on or before to date'], 400);
    }

    $sql = 'SELECT e.id, e.project_id, e.work_date, e.hours, e.notes, e.updated_at,
                   p.name AS project_name, p.code AS project_code, p.color AS project_color
            FROM time_entries e
            INNER JOIN projects p ON p.id = e.project_id
            WHERE e.work_date BETWEEN ? AND ?';
    $types = 'ss';
    $params = [$from, $to];

    if ($projectIds !== '') {
        $ids = array_filter(array_map('intval', explode(',', $projectIds)));
        if (!empty($ids)) {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $sql .= " AND e.project_id IN ({$placeholders})";
            $types .= str_repeat('i', count($ids));
            $params = array_merge($params, $ids);
        }
    }

    $sql .= ' ORDER BY e.work_date ASC, p.sort_order ASC, p.name ASC';

    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        json_response(['ok' => false, 'error' => $stmt->error], 500);
    }
    $result = $stmt->get_result();
    $entries = [];
    $totalHours = 0.0;
    $byProject = [];

    while ($row = $result->fetch_assoc()) {
        $row['id'] = (int) $row['id'];
        $row['project_id'] = (int) $row['project_id'];
        $row['hours'] = (float) $row['hours'];
        $totalHours += $row['hours'];
        $pid = $row['project_id'];
        if (!isset($byProject[$pid])) {
            $byProject[$pid] = [
                'project_id' => $pid,
                'project_name' => $row['project_name'],
                'project_color' => $row['project_color'],
                'hours' => 0,
            ];
        }
        $byProject[$pid]['hours'] += $row['hours'];
        $entries[] = $row;
    }
    $stmt->close();

    json_response([
        'ok' => true,
        'entries' => $entries,
        'summary' => [
            'total_hours' => round($totalHours, 2),
            'by_project' => array_values($byProject),
            'count' => count($entries),
        ],
    ]);
}

if ($method === 'POST') {
    $body = read_json_body();
    $entries = $body['entries'] ?? null;
    if (!is_array($entries)) {
        json_response(['ok' => false, 'error' => 'entries array is required'], 400);
    }

    $requireNotes = ($settings['require_notes'] ?? '0') === '1';
    $allowFuture = ($settings['allow_future_dates'] ?? '0') === '1';
    $today = today_in_timezone($settings);
    $maxPerDay = (float) ($settings['max_hours_per_day'] ?? 24);
    $maxPerWeek = (float) ($settings['max_hours_per_week'] ?? 40);
    $weekStart = (int) ($settings['week_start_day'] ?? 1);

    // Normalize and validate
    $clean = [];
    $dayTotals = [];

    foreach ($entries as $i => $entry) {
        $projectId = (int) ($entry['project_id'] ?? 0);
        $workDate = trim($entry['work_date'] ?? '');
        $hours = isset($entry['hours']) ? (float) $entry['hours'] : 0;
        $notes = isset($entry['notes']) ? trim((string) $entry['notes']) : '';

        if ($projectId <= 0 || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $workDate)) {
            json_response(['ok' => false, 'error' => "Invalid project or date at index {$i}"], 400);
        }
        if ($hours <= 0) {
            // Skip empty / zero rows (clear separately via delete or explicit zero clear)
            continue;
        }
        $err = validate_entry_hours($hours, $settings);
        if ($err) {
            json_response(['ok' => false, 'error' => "{$err} ({$workDate})"], 400);
        }
        if ($requireNotes && $notes === '') {
            json_response(['ok' => false, 'error' => "Notes are required ({$workDate})"], 400);
        }
        if (!$allowFuture && $workDate > $today) {
            json_response(['ok' => false, 'error' => "Future dates are not allowed ({$workDate})"], 400);
        }

        $key = $projectId . '|' . $workDate;
        $clean[$key] = [
            'project_id' => $projectId,
            'work_date' => $workDate,
            'hours' => $hours,
            'notes' => $notes === '' ? null : $notes,
        ];
        if (!isset($dayTotals[$workDate])) {
            $dayTotals[$workDate] = 0;
        }
        $dayTotals[$workDate] += $hours;
    }

    // Also account for existing hours on those days outside this batch
    if (!empty($dayTotals)) {
        $dates = array_keys($dayTotals);
        $projectKeys = array_values(array_unique(array_map(function ($e) {
            return $e['project_id'];
        }, $clean)));

        foreach ($dates as $d) {
            // Sum existing entries for the day excluding projects being upserted
            if (empty($projectKeys)) {
                break;
            }
            $placeholders = implode(',', array_fill(0, count($projectKeys), '?'));
            $types = 's' . str_repeat('i', count($projectKeys));
            $params = array_merge([$d], $projectKeys);
            $sql = "SELECT COALESCE(SUM(hours), 0) AS other_hours FROM time_entries
                    WHERE work_date = ? AND project_id NOT IN ({$placeholders})";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $other = (float) $stmt->get_result()->fetch_assoc()['other_hours'];
            $stmt->close();
            if ($dayTotals[$d] + $other > $maxPerDay + 0.001) {
                json_response([
                    'ok' => false,
                    'error' => "Total hours for {$d} would exceed max of {$maxPerDay}",
                ], 400);
            }
        }

        // Week capacity: group batch dates by week and compare against max_hours_per_week
        $weekBuckets = [];
        foreach ($clean as $row) {
            $ts = strtotime($row['work_date']);
            $dow = (int) date('w', $ts);
            $diff = $dow - $weekStart;
            if ($diff < 0) {
                $diff += 7;
            }
            $weekFrom = date('Y-m-d', strtotime("-{$diff} days", $ts));
            $weekTo = date('Y-m-d', strtotime('+6 days', strtotime($weekFrom)));
            $wk = $weekFrom . '|' . $weekTo;
            if (!isset($weekBuckets[$wk])) {
                $weekBuckets[$wk] = ['from' => $weekFrom, 'to' => $weekTo, 'hours' => 0];
            }
            $weekBuckets[$wk]['hours'] += $row['hours'];
        }

        foreach ($weekBuckets as $wk => $bucket) {
            $placeholders = implode(',', array_fill(0, count($projectKeys), '?'));
            $types = 'ss' . str_repeat('i', count($projectKeys));
            $params = array_merge([$bucket['from'], $bucket['to']], $projectKeys);
            $sql = "SELECT COALESCE(SUM(hours), 0) AS other_hours FROM time_entries
                    WHERE work_date BETWEEN ? AND ? AND project_id NOT IN ({$placeholders})";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $other = (float) $stmt->get_result()->fetch_assoc()['other_hours'];
            $stmt->close();
            if ($bucket['hours'] + $other > $maxPerWeek + 0.001) {
                json_response([
                    'ok' => false,
                    'error' => "Week {$bucket['from']} → {$bucket['to']} would exceed max of {$maxPerWeek} hours",
                ], 400);
            }
        }
    }

    // Optional clear zeros: entries with hours === 0 and clear_zeros flag
    $clearZeros = !empty($body['clear_zeros']);
    if ($clearZeros) {
        foreach ($entries as $entry) {
            $projectId = (int) ($entry['project_id'] ?? 0);
            $workDate = trim($entry['work_date'] ?? '');
            $hours = isset($entry['hours']) ? (float) $entry['hours'] : -1;
            if ($projectId > 0 && preg_match('/^\d{4}-\d{2}-\d{2}$/', $workDate) && $hours === 0.0) {
                $del = $conn->prepare('DELETE FROM time_entries WHERE project_id = ? AND work_date = ?');
                $del->bind_param('is', $projectId, $workDate);
                $del->execute();
                $del->close();
            }
        }
    }

    if (empty($clean) && !$clearZeros) {
        json_response(['ok' => false, 'error' => 'No hours to save. Enter hours greater than 0.'], 400);
    }

    $conn->begin_transaction();
    try {
        $upsert = $conn->prepare(
            'INSERT INTO time_entries (project_id, work_date, hours, notes)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE hours = VALUES(hours), notes = VALUES(notes), updated_at = CURRENT_TIMESTAMP'
        );
        $saved = 0;
        foreach ($clean as $row) {
            $pid = $row['project_id'];
            $wdate = $row['work_date'];
            $hrs = $row['hours'];
            $nts = $row['notes']; // may be null
            $upsert->bind_param('isds', $pid, $wdate, $hrs, $nts);
            if (!$upsert->execute()) {
                throw new Exception($upsert->error);
            }
            $saved++;
        }
        $upsert->close();
        $conn->commit();
        json_response(['ok' => true, 'saved' => $saved]);
    } catch (Exception $e) {
        $conn->rollback();
        json_response(['ok' => false, 'error' => $e->getMessage()], 500);
    }
}

if ($method === 'PUT') {
    $body = read_json_body();
    $id = isset($body['id']) ? (int) $body['id'] : 0;
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'Entry id is required'], 400);
    }

    $existing = $conn->prepare('SELECT id, project_id, work_date, hours, notes FROM time_entries WHERE id = ?');
    $existing->bind_param('i', $id);
    $existing->execute();
    $current = $existing->get_result()->fetch_assoc();
    $existing->close();
    if (!$current) {
        json_response(['ok' => false, 'error' => 'Entry not found'], 404);
    }

    $hours = array_key_exists('hours', $body) ? (float) $body['hours'] : (float) $current['hours'];
    $notes = array_key_exists('notes', $body) ? trim((string) $body['notes']) : $current['notes'];
    $workDate = array_key_exists('work_date', $body) ? trim($body['work_date']) : $current['work_date'];
    $projectId = array_key_exists('project_id', $body) ? (int) $body['project_id'] : (int) $current['project_id'];

    if ($hours <= 0) {
        $del = $conn->prepare('DELETE FROM time_entries WHERE id = ?');
        $del->bind_param('i', $id);
        $del->execute();
        $del->close();
        json_response(['ok' => true, 'deleted' => true]);
    }

    $err = validate_entry_hours($hours, $settings);
    if ($err) {
        json_response(['ok' => false, 'error' => $err], 400);
    }

    $requireNotes = ($settings['require_notes'] ?? '0') === '1';
    if ($requireNotes && ($notes === null || $notes === '')) {
        json_response(['ok' => false, 'error' => 'Notes are required'], 400);
    }

    $allowFuture = ($settings['allow_future_dates'] ?? '0') === '1';
    $today = today_in_timezone($settings);
    if (!$allowFuture && $workDate > $today) {
        json_response(['ok' => false, 'error' => 'Future dates are not allowed'], 400);
    }

    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $workDate) || $projectId <= 0) {
        json_response(['ok' => false, 'error' => 'Invalid project or date'], 400);
    }

    // Day total check excluding this entry
    $maxPerDay = (float) ($settings['max_hours_per_day'] ?? 8);
    $maxPerWeek = (float) ($settings['max_hours_per_week'] ?? 40);
    $weekStart = (int) ($settings['week_start_day'] ?? 1);
    $sumStmt = $conn->prepare(
        'SELECT COALESCE(SUM(hours), 0) AS total FROM time_entries WHERE work_date = ? AND id <> ?'
    );
    $sumStmt->bind_param('si', $workDate, $id);
    $sumStmt->execute();
    $other = (float) $sumStmt->get_result()->fetch_assoc()['total'];
    $sumStmt->close();
    if ($other + $hours > $maxPerDay + 0.001) {
        json_response(['ok' => false, 'error' => "Total hours for {$workDate} would exceed max of {$maxPerDay}"], 400);
    }

    $ts = strtotime($workDate);
    $dow = (int) date('w', $ts);
    $diff = $dow - $weekStart;
    if ($diff < 0) {
        $diff += 7;
    }
    $weekFrom = date('Y-m-d', strtotime("-{$diff} days", $ts));
    $weekTo = date('Y-m-d', strtotime('+6 days', strtotime($weekFrom)));
    $weekStmt = $conn->prepare(
        'SELECT COALESCE(SUM(hours), 0) AS total FROM time_entries
         WHERE work_date BETWEEN ? AND ? AND id <> ?'
    );
    $weekStmt->bind_param('ssi', $weekFrom, $weekTo, $id);
    $weekStmt->execute();
    $weekOther = (float) $weekStmt->get_result()->fetch_assoc()['total'];
    $weekStmt->close();
    if ($weekOther + $hours > $maxPerWeek + 0.001) {
        json_response([
            'ok' => false,
            'error' => "Week {$weekFrom} → {$weekTo} would exceed max of {$maxPerWeek} hours",
        ], 400);
    }

    $notesVal = ($notes === null || $notes === '') ? null : $notes;
    $stmt = $conn->prepare(
        'UPDATE time_entries SET project_id = ?, work_date = ?, hours = ?, notes = ? WHERE id = ?'
    );
    $stmt->bind_param('isdsi', $projectId, $workDate, $hours, $notesVal, $id);
    if (!$stmt->execute()) {
        // Unique conflict
        json_response(['ok' => false, 'error' => $stmt->error], 500);
    }
    $stmt->close();
    json_response(['ok' => true]);
}

if ($method === 'DELETE') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    $from = $_GET['from'] ?? '';
    $to = $_GET['to'] ?? '';
    $projectIds = trim($_GET['project_ids'] ?? '');

    // Bulk delete by range
    if ($id <= 0 && $from !== '' && $to !== '') {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
            json_response(['ok' => false, 'error' => 'Invalid date range'], 400);
        }
        $sql = 'DELETE FROM time_entries WHERE work_date BETWEEN ? AND ?';
        $types = 'ss';
        $params = [$from, $to];
        if ($projectIds !== '') {
            $ids = array_filter(array_map('intval', explode(',', $projectIds)));
            if (!empty($ids)) {
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $sql .= " AND project_id IN ({$placeholders})";
                $types .= str_repeat('i', count($ids));
                $params = array_merge($params, $ids);
            }
        }
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        if (!$stmt->execute()) {
            json_response(['ok' => false, 'error' => $stmt->error], 500);
        }
        $deleted = $stmt->affected_rows;
        $stmt->close();
        json_response(['ok' => true, 'deleted' => $deleted]);
    }

    if ($id <= 0) {
        $body = read_json_body();
        $id = isset($body['id']) ? (int) $body['id'] : 0;
    }
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'Entry id or date range is required'], 400);
    }

    $stmt = $conn->prepare('DELETE FROM time_entries WHERE id = ?');
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        json_response(['ok' => false, 'error' => $stmt->error], 500);
    }
    $deleted = $stmt->affected_rows;
    $stmt->close();
    if ($deleted === 0) {
        json_response(['ok' => false, 'error' => 'Entry not found'], 404);
    }
    json_response(['ok' => true, 'deleted' => 1]);
}

json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
