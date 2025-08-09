"use client";
import { useRouter } from "next/navigation";
import { Button, Container, Row, Col, Card, Form } from "react-bootstrap";
import { useState } from "react";

function generateRoomId(): string {
  // 24-char URL-safe id
  return Array.from(crypto.getRandomValues(new Uint8Array(18)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function Home() {
  const router = useRouter();
  const [roomIdInput, setRoomIdInput] = useState("");
  const [nameInput, setNameInput] = useState("");

  const handleCreate = () => {
    const id = generateRoomId();
    const name = nameInput.trim();
    const qs = name ? `?name=${encodeURIComponent(name)}` : "";
    router.push(`/room/${id}${qs}`);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomIdInput.trim()) return;
    const name = nameInput.trim();
    const qs = name ? `?name=${encodeURIComponent(name)}` : "";
    router.push(`/room/${roomIdInput.trim()}${qs}`);
  };

  return (
    <Container className="py-5">
      <Row className="justify-content-center">
        <Col md={8} lg={6}>
          <Card>
            <Card.Body>
              <Card.Title className="mb-3">Group Video Chat</Card.Title>
              <Form.Group className="mb-3">
                <Form.Label>Your name</Form.Label>
                <Form.Control placeholder="Enter display name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
              </Form.Group>
              <div className="d-flex gap-2 mb-4">
                <Button onClick={handleCreate}>Create new room</Button>
              </div>
              <Form onSubmit={handleJoin} className="d-flex gap-2">
                <Form.Control
                  placeholder="Enter room id to join"
                  value={roomIdInput}
                  onChange={(e) => setRoomIdInput(e.target.value)}
                />
                <Button type="submit" variant="secondary">
                  Join
                </Button>
              </Form>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
}
