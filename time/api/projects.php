<?php
require_once __DIR__ . '/../config/db.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $activeOnly = isset($_GET['active']) && $_GET['active'] === '1';
    $sql = 'SELECT id, name, code, color, is_active, sort_order, created_at, updated_at FROM projects';
    if ($activeOnly) {
        $sql .= ' WHERE is_active = 1';
    }
    $sql .= ' ORDER BY sort_order ASC, name ASC';

    $result = $conn->query($sql);
    if (!$result) {
        json_response(['ok' => false, 'error' => $conn->error], 500);
    }

    $projects = [];
    while ($row = $result->fetch_assoc()) {
        $row['id'] = (int) $row['id'];
        $row['is_active'] = (int) $row['is_active'];
        $row['sort_order'] = (int) $row['sort_order'];
        $projects[] = $row;
    }
    json_response(['ok' => true, 'projects' => $projects]);
}

if ($method === 'POST') {
    $body = read_json_body();
    $name = trim($body['name'] ?? '');
    $code = trim($body['code'] ?? '');
    $color = trim($body['color'] ?? '#3d5a80');
    $isActive = isset($body['is_active']) ? (int) (bool) $body['is_active'] : 1;
    $sortOrder = isset($body['sort_order']) ? (int) $body['sort_order'] : 0;

    if ($name === '') {
        json_response(['ok' => false, 'error' => 'Project name is required'], 400);
    }
    if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) {
        $color = '#3d5a80';
    }

    $stmt = $conn->prepare(
        'INSERT INTO projects (name, code, color, is_active, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    $codeVal = $code === '' ? null : $code;
    // mysqli requires variables (by reference) for bind_param
    $stmt->bind_param('sssii', $name, $codeVal, $color, $isActive, $sortOrder);

    if (!$stmt->execute()) {
        json_response(['ok' => false, 'error' => $stmt->error], 500);
    }

    $id = (int) $stmt->insert_id;
    $stmt->close();
    json_response(['ok' => true, 'id' => $id], 201);
}

if ($method === 'PUT') {
    $body = read_json_body();
    $id = isset($body['id']) ? (int) $body['id'] : 0;
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'Project id is required'], 400);
    }

    $fields = [];
    $types = '';
    $values = [];

    if (array_key_exists('name', $body)) {
        $name = trim($body['name']);
        if ($name === '') {
            json_response(['ok' => false, 'error' => 'Project name cannot be empty'], 400);
        }
        $fields[] = 'name = ?';
        $types .= 's';
        $values[] = $name;
    }
    if (array_key_exists('code', $body)) {
        $fields[] = 'code = ?';
        $types .= 's';
        $code = trim((string) $body['code']);
        $values[] = $code === '' ? null : $code;
    }
    if (array_key_exists('color', $body)) {
        $color = trim($body['color']);
        if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) {
            json_response(['ok' => false, 'error' => 'Invalid color'], 400);
        }
        $fields[] = 'color = ?';
        $types .= 's';
        $values[] = $color;
    }
    if (array_key_exists('is_active', $body)) {
        $fields[] = 'is_active = ?';
        $types .= 'i';
        $values[] = (int) (bool) $body['is_active'];
    }
    if (array_key_exists('sort_order', $body)) {
        $fields[] = 'sort_order = ?';
        $types .= 'i';
        $values[] = (int) $body['sort_order'];
    }

    if (empty($fields)) {
        json_response(['ok' => false, 'error' => 'No fields to update'], 400);
    }

    $types .= 'i';
    $values[] = $id;
    $sql = 'UPDATE projects SET ' . implode(', ', $fields) . ' WHERE id = ?';
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$values);

    if (!$stmt->execute()) {
        json_response(['ok' => false, 'error' => $stmt->error], 500);
    }
    if ($stmt->affected_rows < 0) {
        json_response(['ok' => false, 'error' => 'Update failed'], 500);
    }
    $stmt->close();
    json_response(['ok' => true]);
}

if ($method === 'DELETE') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if ($id <= 0) {
        $body = read_json_body();
        $id = isset($body['id']) ? (int) $body['id'] : 0;
    }
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'Project id is required'], 400);
    }

    // Soft-delete if entries exist; hard-delete otherwise
    $check = $conn->prepare('SELECT COUNT(*) AS cnt FROM time_entries WHERE project_id = ?');
    $check->bind_param('i', $id);
    $check->execute();
    $count = (int) $check->get_result()->fetch_assoc()['cnt'];
    $check->close();

    if ($count > 0) {
        $stmt = $conn->prepare('UPDATE projects SET is_active = 0 WHERE id = ?');
        $stmt->bind_param('i', $id);
        if (!$stmt->execute()) {
            json_response(['ok' => false, 'error' => $stmt->error], 500);
        }
        $stmt->close();
        json_response(['ok' => true, 'soft_deleted' => true, 'message' => 'Project deactivated because it has time entries']);
    }

    $stmt = $conn->prepare('DELETE FROM projects WHERE id = ?');
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        json_response(['ok' => false, 'error' => $stmt->error], 500);
    }
    $stmt->close();
    json_response(['ok' => true, 'soft_deleted' => false]);
}

json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
