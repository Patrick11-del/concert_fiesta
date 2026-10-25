import unittest
from datetime import datetime, timedelta, timezone

from app import create_app


class ConcertHubAPITests(unittest.TestCase):
    def setUp(self):
        self.app = create_app(testing=True)
        self.client = self.app.test_client()
        self.hub = self.app.extensions["concert_hub"]

    def login(self, email, password):
        response = self.client.post("/api/login", json={"email": email, "password": password})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["token"]

    def test_list_concerts_does_not_expose_internal_seats(self):
        response = self.client.get("/api/concerts")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.get_json()), 2)
        self.assertNotIn("seats", response.get_json()[0])

    def test_register_login_and_public_user_fields(self):
        response = self.client.post("/api/register", json={
            "name": " Test User ", "email": "TEST@example.com", "password": "password123"
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertNotIn("salt", response.get_json())
        self.assertNotIn("password_digest", response.get_json())
        token = self.login("test@example.com", "password123")
        self.assertTrue(token)

    def test_reject_duplicate_seats_without_mutating_any_seat(self):
        token = self.login("admin@concerthub.test", "admin12345")
        # Admin may book as a user in this demo, preserving the original Go behavior.
        concert_id = min(self.hub.concerts)
        response = self.client.post(f"/api/concerts/{concert_id}/hold",
            headers={"Authorization": f"Bearer {token}"}, json={"seats": ["C1", "C1"]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.hub.concerts[concert_id].seats["C1"].status, "free")

    def test_hold_pay_and_idempotent_retry(self):
        self.client.post("/api/register", json={"name": "Buyer", "email": "buyer@example.com", "password": "password123"})
        token = self.login("buyer@example.com", "password123")
        concert_id = min(self.hub.concerts)
        headers = {"Authorization": f"Bearer {token}"}
        held = self.client.post(f"/api/concerts/{concert_id}/hold", headers=headers, json={"seats": ["C1", "C2"]})
        self.assertEqual(held.status_code, 200, held.get_json())
        hold_id = held.get_json()["holdId"]
        first = self.client.post(f"/api/holds/{hold_id}/pay", headers=headers, json={"cardToken": "demo"})
        self.assertEqual(first.status_code, 201, first.get_json())
        second = self.client.post(f"/api/holds/{hold_id}/pay", headers=headers, json={"cardToken": "demo"})
        self.assertEqual(second.status_code, 200, second.get_json())
        self.assertEqual(first.get_json()["id"], second.get_json()["id"])
        self.assertEqual(len(self.hub.bookings), 1)

    def test_bad_json_and_unauthorized_access(self):
        response = self.client.post("/api/register", data="{oops", content_type="application/json")
        self.assertEqual(response.status_code, 400)
        response = self.client.get("/api/bookings")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
